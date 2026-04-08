/**
 * Run-state persistence layer.
 *
 * Provides the same public API as the previous JSON-file implementation
 * but stores data in the SQLite database managed by `src/mcp/state/database.ts`.
 *
 * Migration: on first access the old `.dispatch/run-state.json` is read,
 * its data is imported into the database, and the file is left in place
 * (for safety — it will simply be ignored after that).
 *
 * Public API (preserved from the original implementation):
 *   loadRunState(cwd)           → RunState | null
 *   saveRunState(cwd, state)    → void
 *   buildTaskId(task)           → string
 *   shouldSkipTask(id, state)   → boolean
 */

import { readFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Task } from "../parser.js";

// ── Public types (unchanged) ──────────────────────────────────

export interface RunStateTask {
  id: string;
  status: "pending" | "running" | "success" | "failed";
  branch?: string;
}

export interface RunState {
  runId: string;
  preRunSha: string;
  tasks: RunStateTask[];
}

// ── SQLite helpers (lazy-loaded to avoid circular deps at module init) ──

async function getDb(cwd: string) {
  const { openDatabase } = await import("../mcp/state/database.js");
  return openDatabase(cwd);
}

// ── Table bootstrap (idempotent) ──────────────────────────────

async function ensureRunStateTable(cwd: string): Promise<void> {
  const db = await getDb(cwd);
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_state (
      run_id     TEXT PRIMARY KEY,
      pre_run_sha TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_state_tasks (
      run_id  TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status  TEXT NOT NULL DEFAULT 'pending',
      branch  TEXT,
      PRIMARY KEY (run_id, task_id),
      FOREIGN KEY (run_id) REFERENCES run_state(run_id)
    );
  `);
}

// ── Migration from JSON (runs once) ──────────────────────────

const _migratedCwds = new Set<string>();

async function migrateFromJson(cwd: string): Promise<void> {
  if (_migratedCwds.has(cwd)) return;
  _migratedCwds.add(cwd);

  const jsonPath = join(cwd, ".dispatch", "run-state.json");
  try {
    const raw = await readFile(jsonPath, "utf-8");
    const state = JSON.parse(raw) as RunState;
    // Only import if there's no existing record in the DB
    const db = await getDb(cwd);
    const existing = db.prepare("SELECT run_id FROM run_state WHERE run_id = ?").get(state.runId);
    if (!existing) {
      await saveRunState(cwd, state);
    }
  } catch {
    // No JSON file or invalid — nothing to migrate
  }
}

// ── Public API ────────────────────────────────────────────────

export async function loadRunState(cwd: string): Promise<RunState | null> {
  await ensureRunStateTable(cwd);
  await migrateFromJson(cwd);

  const db = await getDb(cwd);
  // Load the most-recently updated run
  const row = db.prepare(
    "SELECT run_id, pre_run_sha FROM run_state ORDER BY updated_at DESC LIMIT 1"
  ).get() as { run_id: string; pre_run_sha: string } | undefined;

  if (!row) return null;

  const taskRows = db.prepare(
    "SELECT task_id, status, branch FROM run_state_tasks WHERE run_id = ?"
  ).all(row.run_id) as { task_id: string; status: string; branch: string | null }[];

  return {
    runId: row.run_id,
    preRunSha: row.pre_run_sha,
    tasks: taskRows.map((t) => ({
      id: t.task_id,
      status: t.status as RunStateTask["status"],
      branch: t.branch ?? undefined,
    })),
  };
}

export async function saveRunState(cwd: string, state: RunState): Promise<void> {
  const dir = join(cwd, ".dispatch");
  await mkdir(dir, { recursive: true });
  await ensureRunStateTable(cwd);

  const db = await getDb(cwd);
  const now = Date.now();

  const upsertRun = db.prepare(`
    INSERT INTO run_state (run_id, pre_run_sha, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET pre_run_sha = excluded.pre_run_sha, updated_at = excluded.updated_at
  `);

  const upsertTask = db.prepare(`
    INSERT INTO run_state_tasks (run_id, task_id, status, branch)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id, task_id) DO UPDATE SET status = excluded.status, branch = excluded.branch
  `);

  const tx = db.transaction((s: RunState) => {
    upsertRun.run(s.runId, s.preRunSha, now);
    for (const task of s.tasks) {
      upsertTask.run(s.runId, task.id, task.status, task.branch ?? null);
    }
  });

  tx(state);
}

export function buildTaskId(task: Task): string {
  return `${basename(task.file)}:${task.line}`;
}

export function shouldSkipTask(taskId: string, state: RunState | null): boolean {
  if (!state) return false;
  const entry = state.tasks.find((t) => t.id === taskId);
  return entry?.status === "success";
}
