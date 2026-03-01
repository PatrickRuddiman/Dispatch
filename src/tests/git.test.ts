import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock setup ────────────────────────────────────────────────────────────────
// Must use vi.hoisted so the mock is declared before vi.mock calls run.
// This intercepts `promisify(execFile)` at module load time for all datasources.
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

// Import the actual datasource implementations AFTER mocking
import { datasource as github, getCommitMessages } from "../datasources/github.js";
import { datasource as azdevops } from "../datasources/azdevops.js";
import { datasource as md } from "../datasources/md.js";

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── Section A: GitHub — buildBranchName ────────────────────────────────────────

describe("GitHub datasource — buildBranchName", () => {
  it("builds a branch name from issue number and title", () => {
    expect(github.buildBranchName("42", "Add User Auth")).toBe(
      "dispatch/42-add-user-auth",
    );
  });

  it("strips non-alphanumeric characters and converts to lowercase", () => {
    expect(github.buildBranchName("10", "Fix Bug #123 (Urgent!)")).toBe(
      "dispatch/10-fix-bug-123-urgent",
    );
  });

  it("strips leading and trailing hyphens from slug", () => {
    expect(github.buildBranchName("5", "---Special---")).toBe(
      "dispatch/5-special",
    );
  });

  it("truncates slug to 50 characters", () => {
    expect(github.buildBranchName("1", "a".repeat(100))).toBe(
      "dispatch/1-" + "a".repeat(50),
    );
  });

  it("handles empty title", () => {
    expect(github.buildBranchName("1", "")).toBe("dispatch/1-");
  });

  it("handles mixed case and special characters", () => {
    expect(github.buildBranchName("7", "Hello WORLD! @#$ Test")).toBe(
      "dispatch/7-hello-world-test",
    );
  });
});

// ─── Section B: GitHub — getDefaultBranch ───────────────────────────────────────

describe("GitHub datasource — getDefaultBranch", () => {
  it("returns branch from symbolic-ref when available", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });

    const result = await github.getDefaultBranch({ cwd: "/tmp/repo" });

    expect(result).toBe("main");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: "/tmp/repo" },
    );
  });

  it("falls back to 'main' when symbolic-ref fails but main exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("not a symbolic ref"))
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await github.getDefaultBranch({ cwd: "/tmp/repo" });

    expect(result).toBe("main");
  });

  it("falls back to 'master' when both symbolic-ref and main fail", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("not a symbolic ref"))
      .mockRejectedValueOnce(new Error("not found"));

    const result = await github.getDefaultBranch({ cwd: "/tmp/repo" });

    expect(result).toBe("master");
  });

  it("parses branch name from full ref path", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "refs/remotes/origin/develop\n",
    });

    const result = await github.getDefaultBranch({ cwd: "/tmp/repo" });

    expect(result).toBe("develop");
  });
});

// ─── Section C: GitHub — createAndSwitchBranch ──────────────────────────────────

describe("GitHub datasource — createAndSwitchBranch", () => {
  it("creates a new branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await github.createAndSwitchBranch("dispatch/42-feature", {
      cwd: "/tmp/repo",
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "dispatch/42-feature"],
      { cwd: "/tmp/repo" },
    );
  });

  it("falls back to checkout when branch already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(
        new Error(
          "fatal: a branch named 'dispatch/42-feature' already exists",
        ),
      )
      .mockResolvedValueOnce({ stdout: "" });

    await github.createAndSwitchBranch("dispatch/42-feature", {
      cwd: "/tmp/repo",
    });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["checkout", "-b", "dispatch/42-feature"],
      { cwd: "/tmp/repo" },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["checkout", "dispatch/42-feature"],
      { cwd: "/tmp/repo" },
    );
  });

  it("re-throws non-'already exists' errors", async () => {
    mockExecFile.mockRejectedValue(new Error("permission denied"));

    await expect(
      github.createAndSwitchBranch("dispatch/42-feature", {
        cwd: "/tmp/repo",
      }),
    ).rejects.toThrow("permission denied");
  });
});

// ─── Section D: GitHub — switchBranch ───────────────────────────────────────────

describe("GitHub datasource — switchBranch", () => {
  it("checks out the specified branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await github.switchBranch("main", { cwd: "/tmp/repo" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "main"],
      { cwd: "/tmp/repo" },
    );
  });

  it("propagates errors", async () => {
    mockExecFile.mockRejectedValue(new Error("branch not found"));

    await expect(
      github.switchBranch("nonexistent", { cwd: "/tmp/repo" }),
    ).rejects.toThrow("branch not found");
  });
});

// ─── Section E: GitHub — pushBranch ─────────────────────────────────────────────

describe("GitHub datasource — pushBranch", () => {
  it("pushes with --set-upstream", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await github.pushBranch("dispatch/42-feature", { cwd: "/tmp/repo" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "dispatch/42-feature"],
      { cwd: "/tmp/repo" },
    );
  });

  it("propagates push errors", async () => {
    mockExecFile.mockRejectedValue(new Error("remote rejected"));

    await expect(
      github.pushBranch("dispatch/42-feature", { cwd: "/tmp/repo" }),
    ).rejects.toThrow("remote rejected");
  });
});

// ─── Section F: GitHub — commitAllChanges ───────────────────────────────────────

describe("GitHub datasource — commitAllChanges", () => {
  it("commits when there are staged changes", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" }) // git add -A
      .mockResolvedValueOnce({ stdout: " 3 files changed\n" }) // git diff --cached --stat
      .mockResolvedValueOnce({ stdout: "" }); // git commit

    await github.commitAllChanges("feat: implement feature", {
      cwd: "/tmp/repo",
    });

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["add", "-A"],
      { cwd: "/tmp/repo" },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: "/tmp/repo" },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["commit", "-m", "feat: implement feature"],
      { cwd: "/tmp/repo" },
    );
  });

  it("skips commit when there are no staged changes", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" }) // git add -A
      .mockResolvedValueOnce({ stdout: "" }); // git diff --cached --stat (empty)

    await github.commitAllChanges("feat: implement feature", {
      cwd: "/tmp/repo",
    });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

// ─── Section G: GitHub — createPullRequest ──────────────────────────────────────

describe("GitHub datasource — createPullRequest", () => {
  it("creates PR and returns URL", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "https://github.com/org/repo/pull/1\n",
    });

    const result = await github.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add user auth",
      "",
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe("https://github.com/org/repo/pull/1");
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--title",
        "feat: add user auth",
        "--body",
        "Closes #42",
        "--head",
        "dispatch/42-feature",
      ],
      { cwd: "/tmp/repo" },
    );
  });

  it("passes provided body to gh pr create", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "https://github.com/org/repo/pull/2\n",
    });

    const customBody = "## Summary\n\nImplemented user auth\n\nCloses #42";
    const result = await github.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add user auth",
      customBody,
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe("https://github.com/org/repo/pull/2");
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--title",
        "feat: add user auth",
        "--body",
        customBody,
        "--head",
        "dispatch/42-feature",
      ],
      { cwd: "/tmp/repo" },
    );
  });

  it("returns existing PR URL when PR already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(
        new Error(
          "a pull request for branch 'dispatch/42-feature' already exists",
        ),
      )
      .mockResolvedValueOnce({
        stdout: "https://github.com/org/repo/pull/1\n",
      });

    const result = await github.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add user auth",
      "",
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe("https://github.com/org/repo/pull/1");
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["pr", "view", "dispatch/42-feature", "--json", "url", "--jq", ".url"],
      { cwd: "/tmp/repo" },
    );
  });

  it("re-throws non-'already exists' errors", async () => {
    mockExecFile.mockRejectedValue(new Error("authentication failed"));

    await expect(
      github.createPullRequest("dispatch/42-feature", "42", "feat: auth", "", {
        cwd: "/tmp/repo",
      }),
    ).rejects.toThrow("authentication failed");
  });
});

// ─── Section G2: GitHub — getCommitMessages ─────────────────────────────────────

describe("GitHub datasource — getCommitMessages", () => {
  it("returns commit messages from branch relative to default branch", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "feat: add login page\nfeat: add auth middleware\nfix: handle token expiry\n",
    });

    const messages = await getCommitMessages("main", "/tmp/repo");

    expect(messages).toEqual([
      "feat: add login page",
      "feat: add auth middleware",
      "fix: handle token expiry",
    ]);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["log", "origin/main..HEAD", "--pretty=format:%s"],
      { cwd: "/tmp/repo" },
    );
  });

  it("returns single commit message", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "feat: implement feature\n",
    });

    const messages = await getCommitMessages("main", "/tmp/repo");

    expect(messages).toEqual(["feat: implement feature"]);
  });

  it("returns empty array when no commits exist", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const messages = await getCommitMessages("main", "/tmp/repo");

    expect(messages).toEqual([]);
  });

  it("returns empty array on git log failure", async () => {
    mockExecFile.mockRejectedValue(new Error("fatal: bad revision"));

    const messages = await getCommitMessages("main", "/tmp/repo");

    expect(messages).toEqual([]);
  });
});

// ─── Section H: Azure DevOps — createPullRequest ────────────────────────────────

describe("Azure DevOps datasource — createPullRequest", () => {
  it("creates PR using az repos pr create and returns URL", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({
        url: "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
      }),
    });

    const result = await azdevops.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add auth",
      "",
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe(
      "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "az",
      [
        "repos",
        "pr",
        "create",
        "--title",
        "feat: add auth",
        "--description",
        "Resolves AB#42",
        "--source-branch",
        "dispatch/42-feature",
        "--work-items",
        "42",
        "--output",
        "json",
      ],
      { cwd: "/tmp/repo" },
    );
  });

  it("returns existing PR URL when PR already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            url: "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
          },
        ]),
      });

    const result = await azdevops.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add auth",
      "",
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe(
      "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "az",
      [
        "repos",
        "pr",
        "list",
        "--source-branch",
        "dispatch/42-feature",
        "--status",
        "active",
        "--output",
        "json",
      ],
      { cwd: "/tmp/repo" },
    );
  });

  it("returns empty string when PR already exists but none found", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ stdout: "[]" });

    const result = await azdevops.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add auth",
      "",
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe("");
  });

  it("re-throws non-'already exists' errors", async () => {
    mockExecFile.mockRejectedValue(new Error("auth failed"));

    await expect(
      azdevops.createPullRequest("dispatch/42-feature", "42", "feat: auth", "", {
        cwd: "/tmp/repo",
      }),
    ).rejects.toThrow("auth failed");
  });
});

// ─── Section I: Azure DevOps — buildBranchName ─────────────────────────────────

describe("Azure DevOps datasource — buildBranchName", () => {
  it("builds a branch name with the same format as GitHub", () => {
    expect(azdevops.buildBranchName("42", "Add User Auth")).toBe(
      "dispatch/42-add-user-auth",
    );
  });
});

// ─── Section J: MD datasource — no-op dispatch lifecycle methods ────────────────

describe("MD datasource — no-op dispatch lifecycle methods", () => {
  it("getDefaultBranch resolves to 'main'", async () => {
    const result = await md.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("buildBranchName returns the same slug format", () => {
    expect(md.buildBranchName("42", "My Feature")).toBe(
      "dispatch/42-my-feature",
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("createAndSwitchBranch resolves without error (no-op)", async () => {
    await md.createAndSwitchBranch("dispatch/42-feature", { cwd: "/tmp" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("switchBranch resolves without error (no-op)", async () => {
    await md.switchBranch("main", { cwd: "/tmp" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("pushBranch resolves without error (no-op)", async () => {
    await md.pushBranch("dispatch/42-feature", { cwd: "/tmp" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("commitAllChanges resolves without error (no-op)", async () => {
    await md.commitAllChanges("feat: test", { cwd: "/tmp" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("createPullRequest resolves to empty string (no-op)", async () => {
    const result = await md.createPullRequest(
      "dispatch/42-feature",
      "42",
      "title",
      "",
      { cwd: "/tmp" },
    );
    expect(result).toBe("");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
