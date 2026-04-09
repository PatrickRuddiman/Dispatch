import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../parser.js";

// ─── Hoisted mock references ────────────────────────────────────────

const { mockMkdir } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
}));

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: mockMkdir,
}));

// ─── SQLite mock ─────────────────────────────────────────────────────
//
// run-state.ts dynamically imports openDatabase at call time via:
//   const { openDatabase } = await import("../mcp/state/database.js")
// We mock the whole module so that openDatabase returns a fake DB object.

// The fake DB that tests can configure per-test
const mockDb = {
  exec: vi.fn(),
  prepare: vi.fn(),
  transaction: vi.fn(),
};

vi.mock("../mcp/state/database.js", () => ({
  openDatabase: vi.fn(() => mockDb),
  closeDatabase: vi.fn(),
  resetDatabase: vi.fn(),
  RUN_STATUSES: ["running", "completed", "failed", "cancelled"],
  TASK_STATUSES: ["pending", "running", "success", "failed", "skipped"],
  SPEC_STATUSES: ["running", "completed", "failed"],
}));

// ─── Import module under test (after mocks) ─────────────────────────

import {
  loadRunState,
  saveRunState,
  buildTaskId,
  shouldSkipTask,
  type RunState,
} from "../helpers/run-state.js";

// ─── Fixtures ───────────────────────────────────────────────────────

const VALID_STATE: RunState = {
  runId: "2025-01-01T00:00:00.000Z",
  preRunSha: "abc123def456",
  tasks: [
    { id: "feature.md:3", status: "success" },
    { id: "feature.md:10", status: "failed" },
    { id: "bugfix.md:5", status: "pending" },
  ],
};

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: exec does nothing
  mockDb.exec.mockReturnValue(undefined);

  // Default prepare stub — returns a statement-like object
  mockDb.prepare.mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
    run: vi.fn(),
  });

  // Default transaction stub — executes the callback immediately
  mockDb.transaction.mockImplementation((fn: (s: RunState) => void) => fn);

  mockMkdir.mockResolvedValue(undefined);
});

// ─── loadRunState ───────────────────────────────────────────────────

describe("loadRunState", () => {
  it("returns null when there is no run_state row in the DB", async () => {
    // prepare("SELECT ...").get() → undefined  (already the default)

    const result = await loadRunState("/fake/cwd");

    expect(result).toBeNull();
  });

  it("returns parsed RunState when a row exists", async () => {
    const runRow = { run_id: VALID_STATE.runId, pre_run_sha: VALID_STATE.preRunSha };
    const taskRows = VALID_STATE.tasks.map((t) => ({
      task_id: t.id,
      status: t.status,
      branch: null,
    }));

    const stmtForRun = { get: vi.fn().mockReturnValue(runRow), all: vi.fn(), run: vi.fn() };
    const stmtForTasks = { get: vi.fn(), all: vi.fn().mockReturnValue(taskRows), run: vi.fn() };
    const stmtForMigration = { get: vi.fn().mockReturnValue(undefined), all: vi.fn(), run: vi.fn() };

    let callCount = 0;
    mockDb.prepare.mockImplementation(() => {
      callCount++;
      // 1st call: ensureRunStateTable → exec (not prepare), so:
      // Call order: ensureRunStateTable uses exec, then migrateFromJson calls readFile
      // then loadRunState itself calls prepare twice: SELECT run (get) and SELECT tasks (all)
      // But also migration calls prepare for SELECT run_id inside saveRunState path
      if (callCount === 1) return stmtForRun;       // SELECT run
      if (callCount === 2) return stmtForTasks;     // SELECT tasks
      return stmtForMigration;
    });

    const result = await loadRunState("/fake/cwd2");

    expect(result).not.toBeNull();
    expect(result?.runId).toBe(VALID_STATE.runId);
    expect(result?.preRunSha).toBe(VALID_STATE.preRunSha);
    expect(result?.tasks).toHaveLength(3);
    expect(result?.tasks[0]).toEqual({ id: "feature.md:3", status: "success", branch: undefined });
  });

  it("returns null when task status is unrecognised (falls back to pending)", async () => {
    const runRow = { run_id: "run-1", pre_run_sha: "sha1" };
    const taskRows = [{ task_id: "x.md:1", status: "UNKNOWN", branch: null }];

    let callCount = 0;
    mockDb.prepare.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { get: vi.fn().mockReturnValue(runRow), all: vi.fn(), run: vi.fn() };
      return { get: vi.fn(), all: vi.fn().mockReturnValue(taskRows), run: vi.fn() };
    });

    const result = await loadRunState("/fake/cwd3");

    expect(result?.tasks[0].status).toBe("pending");
  });
});

// ─── saveRunState ───────────────────────────────────────────────────

describe("saveRunState", () => {
  it("creates the .dispatch directory, bootstraps tables, and upserts rows", async () => {
    const runStmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
    const taskStmt = { get: vi.fn(), all: vi.fn(), run: vi.fn() };

    let callCount = 0;
    mockDb.prepare.mockImplementation(() => {
      callCount++;
      if (callCount % 2 === 1) return runStmt;
      return taskStmt;
    });

    // transaction executes the callback with the state argument
    mockDb.transaction.mockImplementation((fn: (s: RunState) => void) => (s: RunState) => fn(s));

    const state: RunState = {
      runId: "2025-06-01T12:00:00.000Z",
      preRunSha: "deadbeef",
      tasks: [{ id: "task.md:1", status: "pending" }],
    };

    await saveRunState("/fake/cwd", state);

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".dispatch"),
      { recursive: true },
    );
    expect(mockDb.exec).toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalled();
  });
});

// ─── buildTaskId ────────────────────────────────────────────────────

describe("buildTaskId", () => {
  it("produces basename:line format from a Task object", () => {
    const task: Task = {
      index: 0,
      text: "Implement the feature",
      line: 42,
      raw: "- [ ] Implement the feature",
      file: "/some/path/to/123-feature.md",
    };

    expect(buildTaskId(task)).toBe("123-feature.md:42");
  });

  it("handles tasks with no directory in the file path", () => {
    const task: Task = {
      index: 0,
      text: "Fix bug",
      line: 1,
      raw: "- [ ] Fix bug",
      file: "simple.md",
    };

    expect(buildTaskId(task)).toBe("simple.md:1");
  });
});

// ─── shouldSkipTask ─────────────────────────────────────────────────

describe("shouldSkipTask", () => {
  it("returns true when the task has success status", () => {
    expect(shouldSkipTask("feature.md:3", VALID_STATE)).toBe(true);
  });

  it("returns false when the task has failed status", () => {
    expect(shouldSkipTask("feature.md:10", VALID_STATE)).toBe(false);
  });

  it("returns false when the task has pending status", () => {
    expect(shouldSkipTask("bugfix.md:5", VALID_STATE)).toBe(false);
  });

  it("returns false when the task has running status", () => {
    const state: RunState = {
      runId: "2025-01-01T00:00:00.000Z",
      preRunSha: "abc123",
      tasks: [{ id: "wip.md:7", status: "running" }],
    };

    expect(shouldSkipTask("wip.md:7", state)).toBe(false);
  });

  it("returns false when the task is not found in state", () => {
    expect(shouldSkipTask("unknown.md:99", VALID_STATE)).toBe(false);
  });

  it("returns false when state is null", () => {
    expect(shouldSkipTask("feature.md:3", null)).toBe(false);
  });
});
