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
  completionCallbacks: Array<() => void>;
}

const liveRuns = new Map<string, LiveRun>();

export function registerLiveRun(runId: string): void {
  liveRuns.set(runId, { runId, callbacks: [], completionCallbacks: [] });
}

export function unregisterLiveRun(runId: string): void {
  const run = liveRuns.get(runId);
  if (run) {
    for (const cb of run.completionCallbacks) {
      try { cb(); } catch { /* swallow */ }
    }
  }
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

/** Check whether a run is currently registered as live (in-flight). */
export function isLiveRun(runId: string): boolean {
  return liveRuns.has(runId);
}

/** Register a callback that fires when unregisterLiveRun is called for this run. */
export function addCompletionCallback(runId: string, cb: () => void): void {
  const run = liveRuns.get(runId);
  if (run) {
    run.completionCallbacks.push(cb);
  }
}

/**
 * Wait for a run to leave the "running" state.
 *
 * 1. Checks DB immediately — if already terminal, returns true.
 * 2. If live, registers a completion callback for instant wakeup.
 * 3. Polls DB every 2s as safety net (race conditions, orphaned runs).
 * 4. Times out after waitMs (capped at 120s), returning false.
 */
export function waitForRunCompletion(
  runId: string,
  waitMs: number,
  getStatus: () => string | null,
): Promise<boolean> {
  const effectiveWait = Math.min(Math.max(waitMs, 0), 120_000);
  if (effectiveWait <= 0) return Promise.resolve(false);

  // Immediate check — only return early if status is terminal (not queued or running)
  const currentStatus = getStatus();
  if (currentStatus !== null && currentStatus !== "running" && currentStatus !== "queued") {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(completed);
    };

    // Event-driven wakeup via completion callback
    if (isLiveRun(runId)) {
      addCompletionCallback(runId, () => settle(true));
    }

    // DB poll safety net (every 2s)
    pollTimer = setInterval(() => {
      const s = getStatus();
      if (s !== null && s !== "running" && s !== "queued") {
        settle(true);
      }
    }, 2_000);

    // Overall timeout
    timeoutTimer = setTimeout(() => settle(false), effectiveWait);
  });
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
  worker_message: string | null;
  queued_at: number | null;
  session_id: string | null;
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
  worker_message: string | null;
  queued_at: number | null;
  session_id: string | null;
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
    workerMessage: row.worker_message,
    queuedAt: row.queued_at,
    sessionId: row.session_id,
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
    workerMessage: row.worker_message,
    queuedAt: row.queued_at,
    sessionId: row.session_id,
  };
}

// ── Run CRUD ──────────────────────────────────────────────────

/** Create a new dispatch run record. Returns the generated runId. */
export function createRun(opts: {
  cwd: string;
  issueIds: string[];
  status?: "queued" | "running";
  workerMessage?: string;
  sessionId?: string;
}): string {
  const runId = randomUUID();
  const db = getDb();
  const now = Date.now();
  const status = opts.status ?? "running";
  db.prepare(`
    INSERT INTO runs (run_id, cwd, issue_ids, status, started_at, worker_message, queued_at, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, opts.cwd, JSON.stringify(opts.issueIds), status, now, opts.workerMessage ?? null, status === "queued" ? now : null, opts.sessionId ?? null);
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
  status?: "queued" | "running";
  workerMessage?: string;
  sessionId?: string;
}): string {
  const runId = randomUUID();
  const db = getDb();
  const now = Date.now();
  const status = opts.status ?? "running";
  db.prepare(`
    INSERT INTO spec_runs (run_id, cwd, issues, status, started_at, worker_message, queued_at, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, opts.cwd, JSON.stringify(opts.issues), status, now, opts.workerMessage ?? null, status === "queued" ? now : null, opts.sessionId ?? null);
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

// ── Queue helpers ────────────────────────────────────────────

/** Queued run entry returned by getNextQueued*. */
export interface QueuedEntry {
  runId: string;
  workerMessage: string;
  table: "runs" | "spec_runs";
}

/** Transition a dispatch run from "queued" → "running". */
export function markRunStarted(runId: string): void {
  getDb().prepare(`
    UPDATE runs SET status = 'running', started_at = ? WHERE run_id = ? AND status = 'queued'
  `).run(Date.now(), runId);
}

/** Transition a spec run from "queued" → "running". */
export function markSpecRunStarted(runId: string): void {
  getDb().prepare(`
    UPDATE spec_runs SET status = 'running', started_at = ? WHERE run_id = ? AND status = 'queued'
  `).run(Date.now(), runId);
}

/**
 * Get the next queued entry (dispatch or spec), ordered by queued_at ASC.
 * Returns the oldest queued run across both tables, or null if none.
 */
export function getNextQueued(): QueuedEntry | null {
  const db = getDb();
  const runRow = db.prepare(
    "SELECT run_id, worker_message FROM runs WHERE status = 'queued' AND worker_message IS NOT NULL ORDER BY queued_at ASC LIMIT 1"
  ).get() as { run_id: string; worker_message: string } | undefined;

  const specRow = db.prepare(
    "SELECT run_id, worker_message FROM spec_runs WHERE status = 'queued' AND worker_message IS NOT NULL ORDER BY queued_at ASC LIMIT 1"
  ).get() as { run_id: string; worker_message: string } | undefined;

  if (!runRow && !specRow) return null;

  // If both exist, pick the one with the earlier queued_at
  if (runRow && specRow) {
    const runQueuedAt = (db.prepare("SELECT queued_at FROM runs WHERE run_id = ?").get(runRow.run_id) as { queued_at: number }).queued_at;
    const specQueuedAt = (db.prepare("SELECT queued_at FROM spec_runs WHERE run_id = ?").get(specRow.run_id) as { queued_at: number }).queued_at;
    if (specQueuedAt < runQueuedAt) {
      return { runId: specRow.run_id, workerMessage: specRow.worker_message, table: "spec_runs" };
    }
    return { runId: runRow.run_id, workerMessage: runRow.worker_message, table: "runs" };
  }

  if (runRow) return { runId: runRow.run_id, workerMessage: runRow.worker_message, table: "runs" };
  return { runId: specRow!.run_id, workerMessage: specRow!.worker_message, table: "spec_runs" };
}

/** Count active (running) runs across both dispatch and spec tables. */
export function countActiveRuns(): number {
  const db = getDb();
  const r1 = db.prepare("SELECT COUNT(*) as cnt FROM runs WHERE status = 'running'").get() as { cnt: number };
  const r2 = db.prepare("SELECT COUNT(*) as cnt FROM spec_runs WHERE status = 'running'").get() as { cnt: number };
  return r1.cnt + r2.cnt;
}

/** Get the 1-based queue position for a run, or null if not queued. */
export function getQueuePosition(runId: string): number | null {
  const db = getDb();

  // Check runs table
  const runRow = db.prepare("SELECT queued_at FROM runs WHERE run_id = ? AND status = 'queued'").get(runId) as { queued_at: number } | undefined;
  if (runRow) {
    const pos = db.prepare(
      "SELECT COUNT(*) as cnt FROM runs WHERE status = 'queued' AND queued_at <= ?"
    ).get(runRow.queued_at) as { cnt: number };
    // Also count spec_runs queued before this one
    const specBefore = db.prepare(
      "SELECT COUNT(*) as cnt FROM spec_runs WHERE status = 'queued' AND queued_at < ?"
    ).get(runRow.queued_at) as { cnt: number };
    return pos.cnt + specBefore.cnt;
  }

  // Check spec_runs table
  const specRow = db.prepare("SELECT queued_at FROM spec_runs WHERE run_id = ? AND status = 'queued'").get(runId) as { queued_at: number } | undefined;
  if (specRow) {
    const pos = db.prepare(
      "SELECT COUNT(*) as cnt FROM spec_runs WHERE status = 'queued' AND queued_at <= ?"
    ).get(specRow.queued_at) as { cnt: number };
    const runsBefore = db.prepare(
      "SELECT COUNT(*) as cnt FROM runs WHERE status = 'queued' AND queued_at < ?"
    ).get(specRow.queued_at) as { cnt: number };
    return pos.cnt + runsBefore.cnt;
  }

  return null;
}

/**
 * Mark all orphaned runs (status "queued" or "running") as failed.
 * Called on startup to clean up from prior crashes.
 * If `exceptSessionId` is provided, runs in that session are skipped
 * (used by CLI --resume to avoid clobbering the session being resumed).
 */
export function markOrphanedRunsFailed(opts?: { exceptSessionId?: string }): void {
  const db = getDb();
  const now = Date.now();
  if (opts?.exceptSessionId) {
    db.prepare(`
      UPDATE runs SET status = 'failed', finished_at = ?, error = 'Server restarted'
      WHERE status IN ('queued', 'running') AND (session_id IS NULL OR session_id != ?)
    `).run(now, opts.exceptSessionId);
    db.prepare(`
      UPDATE spec_runs SET status = 'failed', finished_at = ?, error = 'Server restarted'
      WHERE status IN ('queued', 'running') AND (session_id IS NULL OR session_id != ?)
    `).run(now, opts.exceptSessionId);
  } else {
    db.prepare(`
      UPDATE runs SET status = 'failed', finished_at = ?, error = 'Server restarted'
      WHERE status IN ('queued', 'running')
    `).run(now);
    db.prepare(`
      UPDATE spec_runs SET status = 'failed', finished_at = ?, error = 'Server restarted'
      WHERE status IN ('queued', 'running')
    `).run(now);
  }
}

/** Mark all queued runs as failed (for graceful shutdown). */
export function failAllQueuedRuns(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE runs SET status = 'failed', finished_at = ?, error = 'Server shutting down'
    WHERE status = 'queued'
  `).run(now);
  db.prepare(`
    UPDATE spec_runs SET status = 'failed', finished_at = ?, error = 'Server shutting down'
    WHERE status = 'queued'
  `).run(now);
}

// ── Session helpers ──────────────────────────────────────────

/** Summary of a resumable session. */
export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  totalRuns: number;
  incompleteRuns: number;
  issueIds: string;     // JSON array from first run, for display
}

/**
 * List sessions with incomplete (queued/failed) runs for a given cwd.
 * Returns newest first.
 */
export function listResumableSessions(cwd: string): SessionSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT session_id, MIN(started_at) as started_at,
           COUNT(*) as total_runs,
           SUM(CASE WHEN status IN ('queued', 'failed') THEN 1 ELSE 0 END) as incomplete,
           (SELECT issue_ids FROM runs r2 WHERE r2.session_id = runs.session_id ORDER BY started_at ASC LIMIT 1) as issue_ids
    FROM runs
    WHERE session_id IS NOT NULL AND cwd = ?
      AND session_id IN (
        SELECT DISTINCT session_id FROM runs
        WHERE status IN ('queued', 'failed') AND session_id IS NOT NULL AND cwd = ?
      )
    GROUP BY session_id
    ORDER BY MIN(started_at) DESC
  `).all(cwd, cwd) as Array<{
    session_id: string;
    started_at: number;
    total_runs: number;
    incomplete: number;
    issue_ids: string;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    startedAt: r.started_at,
    totalRuns: r.total_runs,
    incompleteRuns: r.incomplete,
    issueIds: r.issue_ids,
  }));
}

/**
 * Requeue incomplete (failed/queued) runs for a session.
 * Resets their status to "queued" with a fresh queued_at timestamp.
 * Returns the run IDs that were requeued.
 */
export function requeueSessionRuns(sessionId: string): string[] {
  const db = getDb();
  const now = Date.now();

  // Get run IDs before updating
  const runRows = db.prepare(`
    SELECT run_id FROM runs
    WHERE session_id = ? AND status IN ('failed', 'queued')
      AND worker_message IS NOT NULL
  `).all(sessionId) as Array<{ run_id: string }>;

  const specRows = db.prepare(`
    SELECT run_id FROM spec_runs
    WHERE session_id = ? AND status IN ('failed', 'queued')
      AND worker_message IS NOT NULL
  `).all(sessionId) as Array<{ run_id: string }>;

  // Reset to queued
  if (runRows.length > 0) {
    db.prepare(`
      UPDATE runs SET status = 'queued', queued_at = ?, finished_at = NULL, error = NULL
      WHERE session_id = ? AND status IN ('failed', 'queued') AND worker_message IS NOT NULL
    `).run(now, sessionId);
  }

  if (specRows.length > 0) {
    db.prepare(`
      UPDATE spec_runs SET status = 'queued', queued_at = ?, finished_at = NULL, error = NULL
      WHERE session_id = ? AND status IN ('failed', 'queued') AND worker_message IS NOT NULL
    `).run(now, sessionId);
  }

  const runIds = [...runRows.map((r) => r.run_id), ...specRows.map((r) => r.run_id)];

  // Register live runs so completion callbacks work
  for (const runId of runIds) {
    registerLiveRun(runId);
  }

  return runIds;
}
