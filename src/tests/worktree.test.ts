import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock setup ────────────────────────────────────────────────────────────────

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    task: vi.fn(),
    verbose: false,
    formatErrorChain: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

import { log } from "../helpers/logger.js";
import {
  worktreeName,
  createWorktree,
  removeWorktree,
  listWorktrees,
} from "../helpers/worktree.js";

beforeEach(() => {
  mockExecFile.mockReset();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── worktreeName ──────────────────────────────────────────────────────

describe("worktreeName", () => {
  it("strips .md extension and slugifies", () => {
    expect(worktreeName("123-fix-auth-bug.md")).toBe("123-fix-auth-bug");
  });

  it("handles full file paths", () => {
    expect(worktreeName("/tmp/dispatch-abc/123-fix-auth-bug.md")).toBe("123-fix-auth-bug");
  });

  it("handles filenames without .md extension", () => {
    expect(worktreeName("123-some-title")).toBe("123-some-title");
  });

  it("slugifies special characters", () => {
    expect(worktreeName("123-Fix Auth Bug!.md")).toBe("123-fix-auth-bug");
  });

  it("handles .MD extension (case-insensitive)", () => {
    expect(worktreeName("456-test.MD")).toBe("456-test");
  });

  it("lowercases uppercase characters", () => {
    expect(worktreeName("10-Hello-WORLD.md")).toBe("10-hello-world");
  });

  it("collapses runs of non-alphanumeric characters into single hyphens", () => {
    expect(worktreeName("3-foo___bar!!!baz.md")).toBe("3-foo-bar-baz");
  });

  it("handles a deeply nested path", () => {
    expect(worktreeName("/a/b/c/d/7-my-feature.md")).toBe("7-my-feature");
  });
});

// ─── createWorktree ────────────────────────────────────────────────────

describe("createWorktree", () => {
  it("creates a worktree with git worktree add -b", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/repo/.dispatch/worktrees/42-my-feature", "-b", "user/dispatch/42-my-feature"],
      { cwd: "/repo" },
    );
    expect(result).toBe("/repo/.dispatch/worktrees/42-my-feature");
  });

  it("returns the absolute worktree path", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/custom/path", "10-bug.md", "branch-name");

    expect(result).toBe("/custom/path/.dispatch/worktrees/10-bug");
  });

  it("retries without -b when branch already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal: a branch named 'x' already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      "git",
      ["worktree", "add", "/repo/.dispatch/worktrees/42-my-feature", "user/dispatch/42-my-feature"],
      { cwd: "/repo" },
    );
    expect(result).toBe("/repo/.dispatch/worktrees/42-my-feature");
  });

  it("throws on non-branch-exists errors", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("fatal: some other error"));

    await expect(
      createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature"),
    ).rejects.toThrow("some other error");
  });

  it("logs debug message on successful creation", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await createWorktree("/repo", "42-my-feature.md", "dispatch/42-my-feature");

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Created worktree"),
    );
  });

  it("logs debug message when using existing branch", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal: a branch named 'x' already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    await createWorktree("/repo", "42-my-feature.md", "dispatch/42-my-feature");

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("existing branch"),
    );
  });
});

// ─── removeWorktree ────────────────────────────────────────────────────

describe("removeWorktree", () => {
  it("removes a worktree and prunes", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" })  // worktree remove
      .mockResolvedValueOnce({ stdout: "" }); // worktree prune

    await removeWorktree("/repo", "42-my-feature.md");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["worktree", "remove", "/repo/.dispatch/worktrees/42-my-feature"],
      { cwd: "/repo" },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo" },
    );
  });

  it("falls back to --force removal on failure", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("worktree is dirty"))  // normal remove fails
      .mockResolvedValueOnce({ stdout: "" })       // force remove succeeds
      .mockResolvedValueOnce({ stdout: "" });      // prune

    await removeWorktree("/repo", "42-my-feature.md");

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "remove", "--force", "/repo/.dispatch/worktrees/42-my-feature"],
      { cwd: "/repo" },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo" },
    );
  });

  it("warns instead of throwing when both removal attempts fail", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"));

    // Should not throw
    await expect(removeWorktree("/repo", "42-my-feature.md")).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("42-my-feature"),
    );
  });

  it("does not prune when both removal attempts fail", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"));

    await removeWorktree("/repo", "99-nonexistent.md");

    // Only 2 calls: normal remove + force remove, no prune
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("warns if prune fails but does not throw", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" })  // remove succeeds
      .mockRejectedValueOnce(new Error("prune failed"));  // prune fails

    await expect(removeWorktree("/repo", "42-my-feature.md")).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("prune"),
    );
  });

  it("prunes stale entries after successful force removal", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("dirty"))
      .mockResolvedValueOnce({ stdout: "" })  // force worked
      .mockResolvedValueOnce({ stdout: "" }); // prune

    await removeWorktree("/repo", "5-dirty-tree.md");

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo" },
    );
  });
});

// ─── listWorktrees ─────────────────────────────────────────────────────

describe("listWorktrees", () => {
  it("returns git worktree list output", async () => {
    const output = "/repo  abc1234 [main]\n/repo/.dispatch/worktrees/42-feat  def5678 [feat]\n";
    mockExecFile.mockResolvedValueOnce({ stdout: output });

    const result = await listWorktrees("/repo");

    expect(result).toBe(output);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "list"],
      { cwd: "/repo" },
    );
  });

  it("returns empty string and warns on failure", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("not a git repo"));

    const result = await listWorktrees("/repo");

    expect(result).toBe("");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a git repo"),
    );
  });

  it("returns single-line output when only main worktree exists", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "/repo  abc1234 [main]\n" });

    const result = await listWorktrees("/repo");

    expect(result).toBe("/repo  abc1234 [main]\n");
  });
});
