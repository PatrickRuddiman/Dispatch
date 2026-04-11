/**
 * SQLite database layer for the MCP server.
 *
 * Manages the persistent store for:
 *   - dispatch runs (runId, status, timestamps)
 *   - per-run task records (taskId, status, error, branch)
 *   - spec runs
 *
 * Schema is created on first open and is forward-compatible via
 * simple ADD COLUMN migrations tracked in the `schema_version` table.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// ── Record types ──────────────────────────────────────────────

export const RUN_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const TASK_STATUSES = ["pending", "running", "success", "failed", "skipped"] as const;
export const SPEC_STATUSES = ["queued", "running", "completed", "failed"] as const;

export type RunStatus = typeof RUN_STATUSES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export type SpecStatus = typeof SPEC_STATUSES[number];

export interface RunRecord {
  runId: string;
  cwd: string;
  issueIds: string;      // JSON array string, e.g. '["1","2"]'
  status: RunStatus;
  startedAt: number;     // unix ms
  finishedAt: number | null;
  total: number;
  completed: number;
  failed: number;
  error: string | null;
  workerMessage: string | null;  // serialized fork message for queue
  queuedAt: number | null;       // unix ms, set when status = "queued"
  sessionId: string | null;      // groups runs from a single CLI invocation
}

export interface TaskRecord {
  rowId?: number;
  runId: string;
  taskId: string;
  taskText: string;
  file: string;
  line: number;
  status: TaskStatus;
  branch: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SpecRunRecord {
  runId: string;
  cwd: string;
  issues: string;        // JSON string of issues value (string or string[])
  status: SpecStatus;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  generated: number;
  failed: number;
  error: string | null;
  workerMessage: string | null;  // serialized fork message for queue
  queuedAt: number | null;       // unix ms, set when status = "queued"
  sessionId: string | null;      // groups runs from a single CLI invocation
}

// ── Database singleton ────────────────────────────────────────

let _db: Database.Database | null = null;

const CURRENT_SCHEMA_VERSION = 3;

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id         TEXT    PRIMARY KEY,
      cwd            TEXT    NOT NULL,
      issue_ids      TEXT    NOT NULL DEFAULT '[]',
      status         TEXT    NOT NULL DEFAULT 'running',
      started_at     INTEGER NOT NULL,
      finished_at    INTEGER,
      total          INTEGER NOT NULL DEFAULT 0,
      completed      INTEGER NOT NULL DEFAULT 0,
      failed         INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      worker_message TEXT,
      queued_at      INTEGER,
      session_id     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT    NOT NULL,
      task_id     TEXT    NOT NULL,
      task_text   TEXT    NOT NULL DEFAULT '',
      file        TEXT    NOT NULL DEFAULT '',
      line        INTEGER NOT NULL DEFAULT 0,
      status      TEXT    NOT NULL DEFAULT 'pending',
      branch      TEXT,
      error       TEXT,
      started_at  INTEGER,
      finished_at INTEGER,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);

    CREATE TABLE IF NOT EXISTS spec_runs (
      run_id         TEXT    PRIMARY KEY,
      cwd            TEXT    NOT NULL,
      issues         TEXT    NOT NULL DEFAULT '',
      status         TEXT    NOT NULL DEFAULT 'running',
      started_at     INTEGER NOT NULL,
      finished_at    INTEGER,
      total          INTEGER NOT NULL DEFAULT 0,
      generated      INTEGER NOT NULL DEFAULT 0,
      failed         INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      worker_message TEXT,
      queued_at      INTEGER,
      session_id     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_spec_runs_session_id ON spec_runs(session_id);
  `);

  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
  } else {
    if (row.version < 2) migrateToV2(db);
    if (row.version < 3) migrateToV3(db);
    if (row.version < CURRENT_SCHEMA_VERSION) {
      db.prepare("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION);
    }
  }
}

function migrateToV2(db: Database.Database): void {
  // Add queue columns to runs table
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has("worker_message")) {
    db.exec("ALTER TABLE runs ADD COLUMN worker_message TEXT");
  }
  if (!runColNames.has("queued_at")) {
    db.exec("ALTER TABLE runs ADD COLUMN queued_at INTEGER");
  }

  // Add queue columns to spec_runs table
  const specCols = db.prepare("PRAGMA table_info(spec_runs)").all() as Array<{ name: string }>;
  const specColNames = new Set(specCols.map((c) => c.name));
  if (!specColNames.has("worker_message")) {
    db.exec("ALTER TABLE spec_runs ADD COLUMN worker_message TEXT");
  }
  if (!specColNames.has("queued_at")) {
    db.exec("ALTER TABLE spec_runs ADD COLUMN queued_at INTEGER");
  }
}

function migrateToV3(db: Database.Database): void {
  // Add session_id column to runs table
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols.some((c) => c.name === "session_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN session_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id)");
  }

  // Add session_id column to spec_runs table
  const specCols = db.prepare("PRAGMA table_info(spec_runs)").all() as Array<{ name: string }>;
  if (!specCols.some((c) => c.name === "session_id")) {
    db.exec("ALTER TABLE spec_runs ADD COLUMN session_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_spec_runs_session_id ON spec_runs(session_id)");
  }
}

/**
 * Open (or return the already-open) SQLite database.
 * The DB file is placed at `{cwd}/.dispatch/dispatch.db`.
 */
export function openDatabase(cwd: string): Database.Database {
  if (_db) return _db;

  const dispatchDir = join(cwd, ".dispatch");
  mkdirSync(dispatchDir, { recursive: true });

  const dbPath = join(dispatchDir, "dispatch.db");
  const db = new Database(dbPath);

  // Performance settings
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  createSchema(db);

  _db = db;
  return db;
}

/** Close the database (for graceful shutdown). */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Reset the singleton (for testing). */
export function resetDatabase(): void {
  _db = null;
}

// ── Prepared-statement helpers ────────────────────────────────

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error("Database not open. Call openDatabase(cwd) first.");
  }
  return _db;
}
