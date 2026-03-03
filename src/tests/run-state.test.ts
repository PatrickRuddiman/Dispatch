import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../parser.js";

// ─── Hoisted mock references ────────────────────────────────────────

const { mockReadFile, mockWriteFile, mockRename, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockRename: vi.fn(),
  mockMkdir: vi.fn(),
}));

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rename: mockRename,
  mkdir: mockMkdir,
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
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  mockRename.mockReset();
  mockMkdir.mockReset();
});

// ─── loadRunState ───────────────────────────────────────────────────

describe("loadRunState", () => {
  it("returns null when the state file does not exist", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
    );

    const result = await loadRunState("/fake/cwd");

    expect(result).toBeNull();
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining("run-state.json"),
      "utf-8",
    );
  });

  it("returns parsed RunState from valid JSON", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_STATE));

    const result = await loadRunState("/fake/cwd");

    expect(result).toEqual(VALID_STATE);
  });

  it("returns null for malformed JSON", async () => {
    mockReadFile.mockResolvedValue("not valid json {{");

    const result = await loadRunState("/fake/cwd");

    expect(result).toBeNull();
  });
});

// ─── saveRunState ───────────────────────────────────────────────────

describe("saveRunState", () => {
  it("writes to a temp file then renames atomically", async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const state: RunState = {
      runId: "2025-06-01T12:00:00.000Z",
      preRunSha: "deadbeef",
      tasks: [{ id: "task.md:1", status: "pending" }],
    };

    await saveRunState("/fake/cwd", state);

    expect(mockMkdir).toHaveBeenCalledOnce();
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".dispatch"),
      { recursive: true },
    );

    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("run-state.json.tmp"),
      JSON.stringify(state, null, 2),
      "utf-8",
    );

    expect(mockRename).toHaveBeenCalledOnce();
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringContaining("run-state.json.tmp"),
      expect.stringContaining("run-state.json"),
    );
    expect(mockRename.mock.calls[0][1]).not.toMatch(/\.tmp$/);
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
