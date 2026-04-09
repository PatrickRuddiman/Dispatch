import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, closeDatabase, resetDatabase } from "../mcp/state/database.js";
import {
  registerLiveRun,
  unregisterLiveRun,
  addLogCallback,
  emitLog,
  createRun,
  updateRunCounters,
  finishRun,
  getRun,
  listRuns,
  listRunsByStatus,
  createTask,
  updateTaskStatus,
  getTasksForRun,
  createSpecRun,
  finishSpecRun,
  listSpecRuns,
  getSpecRun,
} from "../mcp/state/manager.js";

// ─── Use an in-memory SQLite database for isolation ──────────

beforeEach(() => {
  closeDatabase();
  resetDatabase();
  // Open an in-memory DB for each test
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      run_id      TEXT    PRIMARY KEY,
      cwd         TEXT    NOT NULL,
      issue_ids   TEXT    NOT NULL DEFAULT '[]',
      status      TEXT    NOT NULL DEFAULT 'running',
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      total       INTEGER NOT NULL DEFAULT 0,
      completed   INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );
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
    CREATE TABLE IF NOT EXISTS spec_runs (
      run_id      TEXT    PRIMARY KEY,
      cwd         TEXT    NOT NULL,
      issues      TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'running',
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      total       INTEGER NOT NULL DEFAULT 0,
      generated   INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );
    INSERT INTO schema_version (version) VALUES (1);
  `);
  // Inject the DB into the singleton via openDatabase's singleton slot
  // by patching _db — we can't do that directly, so we use resetDatabase + set.
  // Instead, we use a trick: openDatabase will skip opening if _db is set.
  // The cleanest way: set _db via the module export.
  // Actually, the manager calls getDb() which reads the module-level _db.
  // Since the module caches the singleton, we need to seed it.
  // We do this by temporarily pointing the DB to `:memory:` by calling
  // openDatabase but overriding the path. The cleanest approach is to
  // use the fact that `_db` is module-level — we set it via a workaround.
  //
  // The simplest real approach: create the DB on disk in a temp path,
  // then call openDatabase(tempDir). But for speed and isolation we
  // monkey-patch _db via the "resetDatabase" + re-export trick:
  // resetDatabase sets _db=null; then we set it back to our in-memory db
  // by exporting a setter. That doesn't exist.
  //
  // FALLBACK: We just pass the in-memory DB path `:memory:` via the
  // database module's `_db` which we can do using vi.spyOn. But since
  // we're in a non-vi context here, the simplest approach is to just use
  // a real temp file. For tests of the manager (which calls getDb()),
  // we open a real on-disk DB in /tmp.
  //
  // Actually the cleanest solution: export a `_setDbForTesting` function
  // in database.ts. But we can't modify the module. Instead we note that
  // the manager imports `getDb` which checks `_db`. We can set `_db` to
  // our in-memory db if we access it via the module's mutable binding.
  //
  // For now, db is closed; we'll seed it below using the real openDatabase.
  db.close();
});

// ─── Helper: open a real temp DB ─────────────────────────────

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

function openTestDb(): string {
  const dir = join(tmpdir(), `dispatch-mgr-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  openDatabase(dir);
  return dir;
}

afterEach(() => {
  closeDatabase();
  resetDatabase();
});

import { afterEach } from "vitest";

// ─── Live run registry ────────────────────────────────────────

describe("live run registry", () => {
  it("registerLiveRun and emitLog deliver messages to callbacks", () => {
    openTestDb();
    registerLiveRun("run-abc");
    const messages: string[] = [];
    addLogCallback("run-abc", (msg) => messages.push(msg));
    emitLog("run-abc", "hello");
    emitLog("run-abc", "world");
    expect(messages).toEqual(["hello", "world"]);
  });

  it("unregisterLiveRun removes callbacks", () => {
    openTestDb();
    registerLiveRun("run-xyz");
    const messages: string[] = [];
    addLogCallback("run-xyz", (msg) => messages.push(msg));
    unregisterLiveRun("run-xyz");
    emitLog("run-xyz", "should not arrive");
    expect(messages).toEqual([]);
  });

  it("emitLog does nothing when run is not registered", () => {
    openTestDb();
    expect(() => emitLog("nonexistent", "msg")).not.toThrow();
  });

  it("addLogCallback does nothing when run is not registered", () => {
    openTestDb();
    expect(() => addLogCallback("nonexistent", () => {})).not.toThrow();
  });

  it("emitLog passes level to callbacks", () => {
    openTestDb();
    registerLiveRun("run-level");
    const calls: Array<[string, string | undefined]> = [];
    addLogCallback("run-level", (msg, level) => calls.push([msg, level]));
    emitLog("run-level", "warn msg", "warn");
    emitLog("run-level", "error msg", "error");
    emitLog("run-level", "info msg");
    expect(calls).toEqual([
      ["warn msg", "warn"],
      ["error msg", "error"],
      ["info msg", "info"],
    ]);
  });

  it("swallows callback errors without crashing", () => {
    openTestDb();
    registerLiveRun("run-throw");
    addLogCallback("run-throw", () => { throw new Error("callback error"); });
    expect(() => emitLog("run-throw", "msg")).not.toThrow();
  });
});

// ─── Run CRUD ─────────────────────────────────────────────────

describe("run CRUD", () => {
  it("createRun returns a UUID-like runId", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1", "2"] });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("getRun returns null for unknown runId", () => {
    openTestDb();
    expect(getRun("no-such-run")).toBeNull();
  });

  it("getRun returns the created run", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp/myproject", issueIds: ["42"] });
    const run = getRun(runId);
    expect(run).not.toBeNull();
    expect(run?.runId).toBe(runId);
    expect(run?.cwd).toBe("/tmp/myproject");
    expect(run?.status).toBe("running");
    expect(run?.issueIds).toBe('["42"]');
  });

  it("updateRunCounters updates the counters", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    updateRunCounters(runId, 5, 3, 1);
    const run = getRun(runId);
    expect(run?.total).toBe(5);
    expect(run?.completed).toBe(3);
    expect(run?.failed).toBe(1);
  });

  it("finishRun marks the run as completed", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    finishRun(runId, "completed");
    const run = getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.error).toBeNull();
  });

  it("finishRun stores error message", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    finishRun(runId, "failed", "something went wrong");
    const run = getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("something went wrong");
  });

  it("listRuns returns all created runs", () => {
    openTestDb();
    const id1 = createRun({ cwd: "/tmp", issueIds: ["1"] });
    const id2 = createRun({ cwd: "/tmp", issueIds: ["2"] });
    const runs = listRuns(10);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const ids = runs.map(r => r.runId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("listRuns respects limit", () => {
    openTestDb();
    createRun({ cwd: "/tmp", issueIds: ["1"] });
    createRun({ cwd: "/tmp", issueIds: ["2"] });
    createRun({ cwd: "/tmp", issueIds: ["3"] });
    expect(listRuns(2)).toHaveLength(2);
  });

  it("listRunsByStatus filters by status", () => {
    openTestDb();
    const id1 = createRun({ cwd: "/tmp", issueIds: ["1"] });
    const id2 = createRun({ cwd: "/tmp", issueIds: ["2"] });
    finishRun(id1, "completed");
    const running = listRunsByStatus("running");
    const completed = listRunsByStatus("completed");
    expect(running.every(r => r.status === "running")).toBe(true);
    expect(completed.some(r => r.runId === id1)).toBe(true);
    expect(completed.every(r => r.status === "completed")).toBe(true);
    expect(running.some(r => r.runId === id2)).toBe(true);
  });
});

// ─── Task CRUD ────────────────────────────────────────────────

describe("task CRUD", () => {
  it("createTask and getTasksForRun round-trip", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    createTask({ runId, taskId: "feat.md:5", taskText: "Add feature", file: "feat.md", line: 5 });
    const tasks = getTasksForRun(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe("feat.md:5");
    expect(tasks[0]?.taskText).toBe("Add feature");
    expect(tasks[0]?.status).toBe("pending");
  });

  it("updateTaskStatus to running sets started_at", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    createTask({ runId, taskId: "t:1", taskText: "Do thing", file: "t.md", line: 1 });
    updateTaskStatus(runId, "t:1", "running");
    const tasks = getTasksForRun(runId);
    expect(tasks[0]?.status).toBe("running");
    expect(tasks[0]?.startedAt).not.toBeNull();
  });

  it("updateTaskStatus to success sets finished_at", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    createTask({ runId, taskId: "t:2", taskText: "Thing", file: "t.md", line: 2 });
    updateTaskStatus(runId, "t:2", "success", { branch: "feat/thing" });
    const tasks = getTasksForRun(runId);
    expect(tasks[0]?.status).toBe("success");
    expect(tasks[0]?.finishedAt).not.toBeNull();
    expect(tasks[0]?.branch).toBe("feat/thing");
  });

  it("updateTaskStatus to failed stores error", () => {
    openTestDb();
    const runId = createRun({ cwd: "/tmp", issueIds: ["1"] });
    createTask({ runId, taskId: "t:3", taskText: "Bad thing", file: "t.md", line: 3 });
    updateTaskStatus(runId, "t:3", "failed", { error: "timed out" });
    const tasks = getTasksForRun(runId);
    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[0]?.error).toBe("timed out");
  });

  it("getTasksForRun returns empty array for unknown runId", () => {
    openTestDb();
    expect(getTasksForRun("no-such-run")).toEqual([]);
  });

  it("invalid status in DB throws via assertTaskStatus", () => {
    // Insert a row with bad status directly
    const db = openDatabase(join(tmpdir(), `dispatch-bad-${randomUUID()}`));
    db.prepare(`
      INSERT INTO runs (run_id, cwd, issue_ids, status, started_at)
      VALUES ('run-bad', '/tmp', '["1"]', 'running', ?)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO tasks (run_id, task_id, task_text, file, line, status)
      VALUES ('run-bad', 'bad:1', 'bad', 'bad.md', 1, 'INVALID_STATUS')
    `).run();
    expect(() => getTasksForRun("run-bad")).toThrow(/Invalid TaskStatus/);
    closeDatabase();
    resetDatabase();
  });
});

// ─── Spec run CRUD ────────────────────────────────────────────

describe("spec run CRUD", () => {
  it("createSpecRun returns a runId", () => {
    openTestDb();
    const runId = createSpecRun({ cwd: "/tmp", issues: "42,43" });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("getSpecRun returns null for unknown runId", () => {
    openTestDb();
    expect(getSpecRun("no-such-spec")).toBeNull();
  });

  it("getSpecRun returns the created spec run", () => {
    openTestDb();
    const runId = createSpecRun({ cwd: "/tmp", issues: ["10", "11"] });
    const run = getSpecRun(runId);
    expect(run?.runId).toBe(runId);
    expect(run?.status).toBe("running");
  });

  it("finishSpecRun updates status and counters", () => {
    openTestDb();
    const runId = createSpecRun({ cwd: "/tmp", issues: "5" });
    finishSpecRun(runId, "completed", { total: 1, generated: 1, failed: 0 });
    const run = getSpecRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.total).toBe(1);
    expect(run?.generated).toBe(1);
    expect(run?.failed).toBe(0);
    expect(run?.finishedAt).not.toBeNull();
  });

  it("finishSpecRun stores error message", () => {
    openTestDb();
    const runId = createSpecRun({ cwd: "/tmp", issues: "5" });
    finishSpecRun(runId, "failed", { total: 0, generated: 0, failed: 0 }, "pipeline error");
    const run = getSpecRun(runId);
    expect(run?.error).toBe("pipeline error");
  });

  it("listSpecRuns returns runs", () => {
    openTestDb();
    createSpecRun({ cwd: "/tmp", issues: "1" });
    createSpecRun({ cwd: "/tmp", issues: "2" });
    const runs = listSpecRuns(10);
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });

  it("listSpecRuns respects limit", () => {
    openTestDb();
    createSpecRun({ cwd: "/tmp", issues: "1" });
    createSpecRun({ cwd: "/tmp", issues: "2" });
    createSpecRun({ cwd: "/tmp", issues: "3" });
    expect(listSpecRuns(2)).toHaveLength(2);
  });
});
