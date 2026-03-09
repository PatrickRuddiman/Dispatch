import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

const SHELL = process.platform === "win32";

// ─── Mock setup ────────────────────────────────────────────────────────────────

const { mockExecFile, mockExistsSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
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
  generateFeatureBranchName,
} from "../helpers/worktree.js";

beforeEach(() => {
  mockExecFile.mockReset();
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── worktreeName ──────────────────────────────────────────────────────

describe("worktreeName", () => {
  it("extracts leading numeric ID and prefixes with issue-", () => {
    expect(worktreeName("123-fix-auth-bug.md")).toBe("issue-123");
  });

  it("handles full file paths", () => {
    expect(worktreeName("/tmp/dispatch-abc/123-fix-auth-bug.md")).toBe("issue-123");
  });

  it("handles filenames without .md extension", () => {
    expect(worktreeName("123-some-title")).toBe("issue-123");
  });

  it("handles filenames with special characters", () => {
    expect(worktreeName("123-Fix Auth Bug!.md")).toBe("issue-123");
  });

  it("handles .MD extension (case-insensitive)", () => {
    expect(worktreeName("456-test.MD")).toBe("issue-456");
  });

  it("handles uppercase filenames", () => {
    expect(worktreeName("10-Hello-WORLD.md")).toBe("issue-10");
  });

  it("handles filenames with non-alphanumeric characters", () => {
    expect(worktreeName("3-foo___bar!!!baz.md")).toBe("issue-3");
  });

  it("handles a deeply nested path", () => {
    expect(worktreeName("/a/b/c/d/7-my-feature.md")).toBe("issue-7");
  });

  it("falls back to slugified name when no leading digits", () => {
    expect(worktreeName("no-number-here.md")).toBe("no-number-here");
  });
});

// ─── createWorktree ────────────────────────────────────────────────────

describe("createWorktree", () => {
  it("creates a worktree with git worktree add -b", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", join("/repo", ".dispatch", "worktrees", "issue-42"), "-b", "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(result).toBe(join("/repo", ".dispatch", "worktrees", "issue-42"));
  });

  it("returns the absolute worktree path", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/custom/path", "10-bug.md", "branch-name");

    expect(result).toBe(join("/custom/path", ".dispatch", "worktrees", "issue-10"));
  });

  it("retries without -b when branch already exists", async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal: a branch named 'x' already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      "git",
      ["worktree", "add", join("/repo", ".dispatch", "worktrees", "issue-42"), "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(result).toBe(join("/repo", ".dispatch", "worktrees", "issue-42"));
  });

  it("removes a stale worktree before creating a new one", async () => {
    const worktreePath = join("/repo", ".dispatch", "worktrees", "issue-42");
    mockExistsSync.mockReturnValue(true);
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature");

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["worktree", "remove", worktreePath],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "add", worktreePath, "-b", "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(log.debug).toHaveBeenCalledWith(
      `Detected stale worktree at ${worktreePath}; removing before creation`,
    );
    expect(log.debug).toHaveBeenCalledWith(
      `Removed stale worktree at ${worktreePath}`,
    );
    expect(result).toBe(worktreePath);
  });

  it("cleans up a stale worktree before retrying without -b", async () => {
    const worktreePath = join("/repo", ".dispatch", "worktrees", "issue-42");
    mockExistsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal: '/repo/.dispatch/worktrees/issue-42' already exists"))
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree("/repo", "42-my-feature.md", "user/dispatch/42-my-feature");

    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["worktree", "add", worktreePath, "-b", "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "remove", worktreePath],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      4,
      "git",
      ["worktree", "add", worktreePath, "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(log.debug).toHaveBeenCalledWith(
      `Detected stale worktree at ${worktreePath}; removing before creation`,
    );
    expect(log.debug).toHaveBeenCalledWith(
      `Removed stale worktree at ${worktreePath}`,
    );
    expect(result).toBe(worktreePath);
  });

  it("continues with fallback when stale worktree cleanup fails", async () => {
    const worktreePath = join("/repo", ".dispatch", "worktrees", "issue-42");

    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    mockExecFile
      .mockRejectedValueOnce(new Error("worktree is dirty"))
      .mockRejectedValueOnce(new Error("force remove failed"))
      .mockRejectedValueOnce(new Error("fatal: a branch named 'x' already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await createWorktree(
      "/repo",
      "42-my-feature.md",
      "user/dispatch/42-my-feature",
    );

    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["worktree", "remove", worktreePath],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "add", worktreePath, "-b", "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      4,
      "git",
      ["worktree", "add", worktreePath, "user/dispatch/42-my-feature"],
      { cwd: "/repo", shell: SHELL },
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not remove worktree issue-42"),
    );
    expect(result).toBe(worktreePath);
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
      ["worktree", "remove", join("/repo", ".dispatch", "worktrees", "issue-42")],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo", shell: SHELL },
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
      ["worktree", "remove", "--force", join("/repo", ".dispatch", "worktrees", "issue-42")],
      { cwd: "/repo", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "prune"],
      { cwd: "/repo", shell: SHELL },
    );
  });

  it("warns instead of throwing when both removal attempts fail", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"));

    // Should not throw
    await expect(removeWorktree("/repo", "42-my-feature.md")).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("issue-42"),
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
      { cwd: "/repo", shell: SHELL },
    );
  });
});

// ─── listWorktrees ─────────────────────────────────────────────────────

describe("listWorktrees", () => {
  it("returns git worktree list output", async () => {
    const output = "/repo  abc1234 [main]\n/repo/.dispatch/worktrees/issue-42  def5678 [feat]\n";
    mockExecFile.mockResolvedValueOnce({ stdout: output });

    const result = await listWorktrees("/repo");

    expect(result).toBe(output);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "list"],
      { cwd: "/repo", shell: SHELL },
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

// ─── generateFeatureBranchName ─────────────────────────────────────────

describe("generateFeatureBranchName", () => {
  it("returns a string matching dispatch/feature-{8-hex-chars}", () => {
    const name = generateFeatureBranchName();
    expect(name).toMatch(/^dispatch\/feature-[0-9a-f]{8}$/);
  });

  it("generates unique names on successive calls", () => {
    const a = generateFeatureBranchName();
    const b = generateFeatureBranchName();
    expect(a).not.toBe(b);
  });
});
