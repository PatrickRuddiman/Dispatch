import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

import {
  buildBranchName,
  getCurrentBranch,
  getDefaultBranch,
  createAndSwitchBranch,
  switchBranch,
  pushBranch,
  createPullRequest,
  commitTask,
  commitAllChanges,
} from "../git.js";

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── buildBranchName (pure function) ─────────────────────────────────

describe("buildBranchName", () => {
  it("converts a simple title to a slug", () => {
    expect(buildBranchName("42", "Add User Auth")).toBe(
      "dispatch/42-add-user-auth",
    );
  });

  it("strips special characters", () => {
    expect(buildBranchName("10", "Fix Bug #123 (Urgent!)")).toBe(
      "dispatch/10-fix-bug-123-urgent",
    );
  });

  it("strips leading and trailing hyphens from the slug", () => {
    expect(buildBranchName("5", "---Special---")).toBe(
      "dispatch/5-special",
    );
  });

  it("truncates the slug to 60 characters", () => {
    expect(buildBranchName("1", "a".repeat(100))).toBe(
      "dispatch/1-" + "a".repeat(60),
    );
  });

  it("handles mixed case and symbols", () => {
    expect(buildBranchName("7", "Hello WORLD! @#$ Test")).toBe(
      "dispatch/7-hello-world-test",
    );
  });

  it("handles numbers in the title", () => {
    expect(buildBranchName("99", "v2.0 Release Notes")).toBe(
      "dispatch/99-v2-0-release-notes",
    );
  });

  it("handles a single-word title", () => {
    expect(buildBranchName("1", "refactor")).toBe("dispatch/1-refactor");
  });

  it("handles an empty title", () => {
    expect(buildBranchName("1", "")).toBe("dispatch/1-");
  });

  it("handles a title that becomes empty after slug processing", () => {
    expect(buildBranchName("1", "!@#$%")).toBe("dispatch/1-");
  });

  it("does not truncate a slug that is exactly 60 characters", () => {
    const sixtyChars = "a".repeat(60);
    expect(buildBranchName("1", sixtyChars)).toBe(
      `dispatch/1-${sixtyChars}`,
    );
  });

  it("truncates a slug that is 61+ characters", () => {
    const sixtyOneChars = "a".repeat(61);
    expect(buildBranchName("1", sixtyOneChars)).toBe(
      `dispatch/1-${"a".repeat(60)}`,
    );
  });
});

// ─── getCurrentBranch ────────────────────────────────────────────────

describe("getCurrentBranch", () => {
  it("returns the trimmed branch name", async () => {
    mockExecFile.mockResolvedValue({ stdout: "main\n" });
    const result = await getCurrentBranch("/tmp/repo");
    expect(result).toBe("main");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: "/tmp/repo" },
    );
  });

  it("propagates errors from git", async () => {
    mockExecFile.mockRejectedValue(new Error("not a git repo"));
    await expect(getCurrentBranch("/tmp/bad")).rejects.toThrow(
      "not a git repo",
    );
  });
});

// ─── getDefaultBranch ────────────────────────────────────────────────

describe("getDefaultBranch", () => {
  it("returns branch from symbolic-ref when available", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "refs/remotes/origin/main\n",
    });
    const result = await getDefaultBranch("/tmp/repo");
    expect(result).toBe("main");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: "/tmp/repo" },
    );
  });

  it("returns 'main' when symbolic-ref fails but main branch exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("not a symbolic ref"))
      .mockResolvedValueOnce({ stdout: "abc123\n" });
    const result = await getDefaultBranch("/tmp/repo");
    expect(result).toBe("main");
  });

  it("returns 'master' when both symbolic-ref and main verification fail", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("not a symbolic ref"))
      .mockRejectedValueOnce(new Error("not a valid ref"));
    const result = await getDefaultBranch("/tmp/repo");
    expect(result).toBe("master");
  });

  it("parses branch name from full ref path", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "refs/remotes/origin/develop\n",
    });
    const result = await getDefaultBranch("/tmp/repo");
    expect(result).toBe("develop");
  });
});

// ─── createAndSwitchBranch ───────────────────────────────────────────

describe("createAndSwitchBranch", () => {
  it("creates and switches to a new branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });
    await createAndSwitchBranch("dispatch/42-feature", "main", "/tmp/repo");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "dispatch/42-feature", "main"],
      { cwd: "/tmp/repo" },
    );
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to checkout + reset when branch already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("branch already exists"))
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });
    await createAndSwitchBranch("dispatch/42-feature", "main", "/tmp/repo");
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["checkout", "dispatch/42-feature"],
      { cwd: "/tmp/repo" },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["reset", "--hard", "main"],
      { cwd: "/tmp/repo" },
    );
  });
});

// ─── switchBranch ────────────────────────────────────────────────────

describe("switchBranch", () => {
  it("checks out the specified branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });
    await switchBranch("main", "/tmp/repo");
    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], {
      cwd: "/tmp/repo",
    });
  });

  it("propagates errors from git", async () => {
    mockExecFile.mockRejectedValue(new Error("branch not found"));
    await expect(switchBranch("nonexistent", "/tmp/repo")).rejects.toThrow(
      "branch not found",
    );
  });
});

// ─── pushBranch ──────────────────────────────────────────────────────

describe("pushBranch", () => {
  it("pushes with --set-upstream to origin", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });
    await pushBranch("dispatch/42-feature", "/tmp/repo");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "dispatch/42-feature"],
      { cwd: "/tmp/repo" },
    );
  });

  it("propagates push errors", async () => {
    mockExecFile.mockRejectedValue(new Error("remote rejected"));
    await expect(
      pushBranch("dispatch/42-feature", "/tmp/repo"),
    ).rejects.toThrow("remote rejected");
  });
});

// ─── createPullRequest ───────────────────────────────────────────────

describe("createPullRequest", () => {
  it("creates a PR and returns the URL", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "https://github.com/org/repo/pull/1\n",
    });
    const url = await createPullRequest(
      "dispatch/42-feature",
      "main",
      "feat: add user auth",
      "Closes #42",
      "/tmp/repo",
    );
    expect(url).toBe("https://github.com/org/repo/pull/1");
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--head",
        "dispatch/42-feature",
        "--base",
        "main",
        "--title",
        "feat: add user auth",
        "--body",
        "Closes #42",
      ],
      { cwd: "/tmp/repo" },
    );
  });

  it("returns empty string when PR already exists", async () => {
    mockExecFile.mockRejectedValue(
      new Error("a pull request for branch already exists"),
    );
    const url = await createPullRequest(
      "dispatch/42-feature",
      "main",
      "feat: add user auth",
      "Closes #42",
      "/tmp/repo",
    );
    expect(url).toBe("");
  });

  it("re-throws errors unrelated to existing PRs", async () => {
    mockExecFile.mockRejectedValue(new Error("authentication failed"));
    await expect(
      createPullRequest(
        "dispatch/42-feature",
        "main",
        "title",
        "body",
        "/tmp/repo",
      ),
    ).rejects.toThrow("authentication failed");
  });
});
