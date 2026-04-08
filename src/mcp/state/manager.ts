/**
 * DispatchStateManager — CRUD layer on top of the SQLite database.
 *
 * Provides:
 *   - Run lifecycle management (create, update status, finish)
 *   - Task tracking per run
 *   - Spec-run tracking
 *   - In-memory live-run registry (used by MCP tools to emit log notifications)
 *
 * All writes are synchronous (better-sqlite3 API), which is intentional for
 * simplicity and data integrity.
 */

import { randomUUID } from "node:crypto";
import { getDb, RUN_STATUSES, TASK_STATUSES, SPEC_STATUSES } from "./database.js";
import type {
  RunRecord,
  TaskRecord,
  RunStatus,
  TaskStatus,
  SpecRunRecord,
  SpecStatus,
} from "./database.js";

// Re-export types for convenience
export type { RunRecord, TaskRecord, SpecRunRecord, RunStatus, TaskStatus, SpecStatus };

// ── Live run registry ─────────────────────────────────────────
// Tracks in-flight runs keyed by runId so MCP notification
// callbacks can be registered and invoked as the pipeline progresses.

export type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

interface LiveRun {
  runId: string;
  callbacks: LogCallback[];
}

const liveRuns = new Map<string, LiveRun>();

export function registerLiveRun(runId: string): void {
  liveRuns.set(runId, { runId, callbacks: [] });
}

export function unregisterLiveRun(runId: string): void {
  liveRuns.delete(runId);
}

export function addLogCallback(runId: string, cb: LogCallback): void {
  const run = liveRuns.get(runId);
  if (run) {
    run.callbacks.push(cb);
  }
}

export function emitLog(runId: string, message: string, level: "info" | "warn" | "error" = "info"): void {
  const run = liveRuns.get(runId);
  if (run) {
    for (const cb of run.callbacks) {
      try {
        cb(message, level);
      } catch (err) {
        // Don't let notification errors crash the pipeline; log at debug level
        if (process.env["DEBUG"]) console.error("[dispatch-mcp] log callback error:", err);
      }
    }
  }
}

// ── Status field runtime validators ──────────────────────────

function assertRunStatus(value: string): RunStatus {
  if ((RUN_STATUSES as readonly string[]).includes(value)) return value as RunStatus;
  throw new Error(`Invalid RunStatus from database: "${value}"`);
}

function assertTaskStatus(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`Invalid TaskStatus from database: "${value}"`);
}

function assertSpecStatus(value: string): SpecStatus {
  if ((SPEC_STATUSES as readonly string[]).includes(value)) return value as SpecStatus;
  throw new Error(`Invalid SpecStatus from database: "${value}"`);
}

// ── Row ↔ record mappers ──────────────────────────────────────

interface RunRow {
  run_id: string;
  cwd: string;
  issue_ids: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  total: number;
  completed: number;
  failed: number;
  error: string | null;
}

interface TaskRow {
  id: number;
  run_id: string;
  task_id: string;
  task_text: string;
  file: string;
  line: number;
  status: string;
  branch: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

interface SpecRunRow {
  run_id: string;
  cwd: string;
  issues: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  total: number;
  generated: number;
  failed: number;
  error: string | null;
}

function rowToRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    cwd: row.cwd,
    issueIds: row.issue_ids,
    status: assertRunStatus(row.status),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    error: row.error,
  };
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    rowId: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    taskText: row.task_text,
    file: row.file,
    line: row.line,
    status: assertTaskStatus(row.status),
    branch: row.branch,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToSpecRun(row: SpecRunRow): SpecRunRecord {
  return {
    runId: row.run_id,
    cwd: row.cwd,
    issues: row.issues,
    status: assertSpecStatus(row.status),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    total: row.total,
    generated: row.generated,
    failed: row.failed,
    error: row.error,
  };
}

// ── Run CRUD ──────────────────────────────────────────────────

/** Create a new dispatch run record. Returns the generated runId. */
export function createRun(opts: {
  cwd: string;
  issueIds: string[];
}): string {
  const runId = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO runs (run_id, cwd, issue_ids, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).run(runId, opts.cwd, JSON.stringify(opts.issueIds), Date.now());
  registerLiveRun(runId);
  return runId;
}

/** Update the status counters for a run. */
export function updateRunCounters(runId: string, total: number, completed: number, failed: number): void {
  getDb().prepare(`
    UPDATE runs SET total = ?, completed = ?, failed = ? WHERE run_id = ?
  `).run(total, completed, failed, runId);
}

/** Mark a run as finished. */
export function finishRun(runId: string, status: RunStatus, error?: string): void {
  getDb().prepare(`
    UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE run_id = ?
  `).run(status, Date.now(), error ?? null, runId);
  unregisterLiveRun(runId);
}

/** Get a single run by ID. */
export function getRun(runId: string): RunRecord | null {
  const row = getDb().prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

/** Get all runs, newest first. */
export function listRuns(limit = 50): RunRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?"
  ).all(limit) as RunRow[];
  return rows.map(rowToRun);
}

/** Get recent runs with a given status. */
export function listRunsByStatus(status: RunStatus, limit = 20): RunRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?"
  ).all(status, limit) as RunRow[];
  return rows.map(rowToRun);
}

// ── Task CRUD ─────────────────────────────────────────────────

/** Insert a task record for a run. */
export function createTask(opts: {
  runId: string;
  taskId: string;
  taskText: string;
  file: string;
  line: number;
}): void {
  getDb().prepare(`
    INSERT INTO tasks (run_id, task_id, task_text, file, line, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(opts.runId, opts.taskId, opts.taskText, opts.file, opts.line);
}

/** Update task status. */
export function updateTaskStatus(
  runId: string,
  taskId: string,
  status: TaskStatus,
  opts?: { error?: string; branch?: string },
): void {
  const now = Date.now();
  const isTerminal = status === "success" || status === "failed" || status === "skipped";
  const isStart = status === "running";

  if (isStart) {
    getDb().prepare(`
      UPDATE tasks SET status = ?, started_at = ?, error = NULL
      WHERE run_id = ? AND task_id = ?
    `).run(status, now, runId, taskId);
  } else if (isTerminal) {
    getDb().prepare(`
      UPDATE tasks SET status = ?, finished_at = ?, error = ?, branch = ?
      WHERE run_id = ? AND task_id = ?
    `).run(status, now, opts?.error ?? null, opts?.branch ?? null, runId, taskId);
  } else {
    getDb().prepare(`
      UPDATE tasks SET status = ?, error = ?
      WHERE run_id = ? AND task_id = ?
    `).run(status, opts?.error ?? null, runId, taskId);
  }
}

/** Get all tasks for a run. */
export function getTasksForRun(runId: string): TaskRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM tasks WHERE run_id = ? ORDER BY id ASC"
  ).all(runId) as TaskRow[];
  return rows.map(rowToTask);
}

// ── Spec run CRUD ─────────────────────────────────────────────

/** Create a new spec run record. Returns the generated runId. */
export function createSpecRun(opts: {
  cwd: string;
  issues: string | string[];
}): string {
  const runId = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO spec_runs (run_id, cwd, issues, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).run(runId, opts.cwd, JSON.stringify(opts.issues), Date.now());
  registerLiveRun(runId);
  return runId;
}

/** Mark a spec run as finished. */
export function finishSpecRun(
  runId: string,
  status: SpecStatus,
  counters: { total: number; generated: number; failed: number },
  error?: string,
): void {
  getDb().prepare(`
    UPDATE spec_runs
    SET status = ?, finished_at = ?, total = ?, generated = ?, failed = ?, error = ?
    WHERE run_id = ?
  `).run(status, Date.now(), counters.total, counters.generated, counters.failed, error ?? null, runId);
  unregisterLiveRun(runId);
}

/** Get all spec runs, newest first. */
export function listSpecRuns(limit = 50): SpecRunRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM spec_runs ORDER BY started_at DESC LIMIT ?"
  ).all(limit) as SpecRunRow[];
  return rows.map(rowToSpecRun);
}

/** Get a single spec run. */
export function getSpecRun(runId: string): SpecRunRecord | null {
  const row = getDb().prepare("SELECT * FROM spec_runs WHERE run_id = ?").get(runId) as SpecRunRow | undefined;
  return row ? rowToSpecRun(row) : null;
}
