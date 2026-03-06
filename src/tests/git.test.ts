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
import { buildPrBody, buildPrTitle } from "../orchestrator/datasource-helpers.js";
import type { Task } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import type { IssueDetails } from "../datasources/interface.js";
import { UnsupportedOperationError } from "../helpers/errors.js";

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── Section A: GitHub — buildBranchName ────────────────────────────────────────

describe("GitHub datasource — buildBranchName", () => {
  it("builds a branch name from issue number, title, and username", () => {
    expect(github.buildBranchName("42", "Add User Auth", "jdoe")).toBe(
      "jdoe/dispatch/42-add-user-auth",
    );
  });

  it("strips non-alphanumeric characters and converts to lowercase", () => {
    expect(github.buildBranchName("10", "Fix Bug #123 (Urgent!)", "jdoe")).toBe(
      "jdoe/dispatch/10-fix-bug-123-urgent",
    );
  });

  it("strips leading and trailing hyphens from slug", () => {
    expect(github.buildBranchName("5", "---Special---", "jdoe")).toBe(
      "jdoe/dispatch/5-special",
    );
  });

  it("truncates slug to 50 characters", () => {
    expect(github.buildBranchName("1", "a".repeat(100), "jdoe")).toBe(
      "jdoe/dispatch/1-" + "a".repeat(50),
    );
  });

  it("handles empty title", () => {
    expect(github.buildBranchName("1", "", "jdoe")).toBe("jdoe/dispatch/1-");
  });

  it("handles mixed case and special characters", () => {
    expect(github.buildBranchName("7", "Hello WORLD! @#$ Test", "jdoe")).toBe(
      "jdoe/dispatch/7-hello-world-test",
    );
  });

  it("falls back to 'unknown' when username is omitted", () => {
    expect(github.buildBranchName("42", "Add User Auth")).toBe(
      "unknown/dispatch/42-add-user-auth",
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
      { cwd: "/tmp/repo", shell: false },
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

// ─── Section B2: GitHub — getUsername ───────────────────────────────────────────

describe("GitHub datasource — getUsername", () => {
  it("returns slugified git username", async () => {
    mockExecFile.mockResolvedValue({ stdout: "John Doe\n" });

    const result = await github.getUsername({ cwd: "/tmp/repo" });

    expect(result).toBe("john-doe");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["config", "user.name"],
      { cwd: "/tmp/repo", shell: false },
    );
  });

  it("returns 'unknown' when git config fails", async () => {
    mockExecFile.mockRejectedValue(new Error("no config"));

    const result = await github.getUsername({ cwd: "/tmp/repo" });

    expect(result).toBe("unknown");
  });

  it("returns 'unknown' when git username is empty", async () => {
    mockExecFile.mockResolvedValue({ stdout: "  \n" });

    const result = await github.getUsername({ cwd: "/tmp/repo" });

    expect(result).toBe("unknown");
  });

  it("slugifies usernames with special characters", async () => {
    mockExecFile.mockResolvedValue({ stdout: "Jane O'Brien-Smith\n" });

    const result = await github.getUsername({ cwd: "/tmp/repo" });

    expect(result).toBe("jane-o-brien-smith");
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
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["checkout", "dispatch/42-feature"],
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: "/tmp/repo", shell: false },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["commit", "-m", "feat: implement feature"],
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
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
      { cwd: "/tmp/repo", shell: false },
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

  it("passes provided body to az repos pr create --description", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({
        url: "https://dev.azure.com/org/project/_git/repo/pullrequest/2",
      }),
    });

    const customBody = "## Summary\n\nImplemented auth flow\n\nResolves AB#42";
    const result = await azdevops.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add auth",
      customBody,
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe(
      "https://dev.azure.com/org/project/_git/repo/pullrequest/2",
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
        customBody,
        "--source-branch",
        "dispatch/42-feature",
        "--work-items",
        "42",
        "--output",
        "json",
      ],
      { cwd: "/tmp/repo", shell: false },
    );
  });

  it("uses default description when body is empty string", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({
        url: "https://dev.azure.com/org/project/_git/repo/pullrequest/3",
      }),
    });

    const result = await azdevops.createPullRequest(
      "dispatch/99-fix",
      "99",
      "fix: resolve bug",
      "",
      { cwd: "/tmp/repo" },
    );

    expect(result).toBe(
      "https://dev.azure.com/org/project/_git/repo/pullrequest/3",
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "az",
      [
        "repos",
        "pr",
        "create",
        "--title",
        "fix: resolve bug",
        "--description",
        "Resolves AB#99",
        "--source-branch",
        "dispatch/99-fix",
        "--work-items",
        "99",
        "--output",
        "json",
      ],
      { cwd: "/tmp/repo", shell: false },
    );
  });
});

// ─── Section I: Azure DevOps — buildBranchName ─────────────────────────────────

describe("Azure DevOps datasource — buildBranchName", () => {
  it("builds a branch name with the same format as GitHub", () => {
    expect(azdevops.buildBranchName("42", "Add User Auth", "testuser")).toBe(
      "testuser/dispatch/42-add-user-auth",
    );
  });
});

// ─── Section J: MD datasource — git lifecycle methods ───────────────────────────

describe("MD datasource — git lifecycle methods", () => {
  it("getDefaultBranch detects branch via git symbolic-ref", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n", stderr: "" });
    const result = await md.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
    expect(mockExecFile).toHaveBeenCalledWith("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: "/tmp", shell: false });
  });

  it("getDefaultBranch falls back to main when symbolic-ref fails", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("not set"));
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    const result = await md.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
  });

  it("getDefaultBranch falls back to master when main check also fails", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("not set"));
    mockExecFile.mockRejectedValueOnce(new Error("not found"));
    const result = await md.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("master");
  });

  it("getUsername resolves via git config user.name", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "John Doe\n", stderr: "" });
    const result = await md.getUsername({ cwd: "/tmp" });
    expect(result).toBe("john-doe");
    expect(mockExecFile).toHaveBeenCalledWith("git", ["config", "user.name"], { cwd: "/tmp", shell: false });
  });

  it("getUsername falls back to 'local' on error", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("not configured"));
    const result = await md.getUsername({ cwd: "/tmp" });
    expect(result).toBe("local");
  });

  it("buildBranchName returns the new username-prefixed format", () => {
    expect(md.buildBranchName("42", "My Feature", "local")).toBe(
      "local/dispatch/42-my-feature",
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("createAndSwitchBranch runs git checkout -b", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await md.createAndSwitchBranch("local/dispatch/1-feat", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "-b", "local/dispatch/1-feat"], { cwd: "/tmp", shell: false });
  });

  it("createAndSwitchBranch falls back to checkout when branch exists", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("fatal: a branch named 'x' already exists"));
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await md.createAndSwitchBranch("local/dispatch/1-feat", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenLastCalledWith("git", ["checkout", "local/dispatch/1-feat"], { cwd: "/tmp", shell: false });
  });

  it("switchBranch runs git checkout", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await md.switchBranch("main", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/tmp", shell: false });
  });

  it("pushBranch is a no-op", async () => {
    await md.pushBranch("dispatch/42-feature", { cwd: "/tmp" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("commitAllChanges stages and commits changes", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // git add -A
    mockExecFile.mockResolvedValueOnce({ stdout: " file.ts | 1 +\n", stderr: "" }); // git diff --cached --stat
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // git commit
    await md.commitAllChanges("feat: test", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: "/tmp", shell: false });
    expect(mockExecFile).toHaveBeenCalledWith("git", ["commit", "-m", "feat: test"], { cwd: "/tmp", shell: false });
  });

  it("commitAllChanges skips commit when nothing staged", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // git add -A
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // git diff --cached --stat (empty)
    await md.commitAllChanges("feat: test", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("createPullRequest returns empty string", async () => {
    const result = await md.createPullRequest("dispatch/42-feature", "42", "title", "", {
      cwd: "/tmp",
    });
    expect(result).toBe("");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("createPullRequest with custom body returns empty string", async () => {
    const result = await md.createPullRequest(
      "dispatch/42-feature",
      "42",
      "feat: add auth",
      "## Summary\n\nCustom body content\n\nCloses #42",
      { cwd: "/tmp" },
    );
    expect(result).toBe("");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ─── Section K: PR title builder ────────────────────────────────────────────────

describe("buildPrTitle", () => {
  it("returns issue title when no commits are found", async () => {
    mockExecFile.mockRejectedValue(new Error("fatal: bad revision"));

    const result = await buildPrTitle("Add user auth", "main", "/tmp/repo");

    expect(result).toBe("Add user auth");
  });

  it("returns the single commit message when one commit exists", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "feat: implement login flow\n",
    });

    const result = await buildPrTitle("Add user auth", "main", "/tmp/repo");

    expect(result).toBe("feat: implement login flow");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["log", "main..HEAD", "--pretty=format:%s"],
      { cwd: "/tmp/repo", shell: false },
    );
  });

  it("returns oldest commit with count suffix for multiple commits", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "fix: handle edge case\nfeat: add login page\nfeat: scaffold auth module\n",
    });

    const result = await buildPrTitle("Add user auth", "main", "/tmp/repo");

    expect(result).toBe("feat: scaffold auth module (+2 more)");
  });

  it("returns issue title when git log returns empty output", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const result = await buildPrTitle("My feature", "main", "/tmp/repo");

    expect(result).toBe("My feature");
  });
});

// ─── Section L: PR body builder ─────────────────────────────────────────────────

describe("buildPrBody", () => {
  /** Create a Task fixture. */
  function createTask(overrides?: Partial<Task>): Task {
    return {
      index: 0,
      text: "Implement feature",
      line: 1,
      raw: "- [ ] Implement feature",
      file: "/tmp/dispatch-abc/42-feature.md",
      ...overrides,
    };
  }

  /** Create an IssueDetails fixture. */
  function createIssueDetails(overrides?: Partial<IssueDetails>): IssueDetails {
    return {
      number: "42",
      title: "Default Title",
      body: "Default body",
      labels: [],
      state: "open",
      url: "https://github.com/org/repo/issues/42",
      comments: [],
      acceptanceCriteria: "",
      ...overrides,
    };
  }

  it("includes commit summaries in the body", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "feat: add login\nfeat: add signup\n",
    });

    const details = createIssueDetails({ number: "42", labels: [] });
    const task = createTask({ text: "Add login" });
    const result: DispatchResult = { task, success: true };

    const body = await buildPrBody(details, [task], [result], "main", "github", "/tmp/repo");

    expect(body).toContain("## Summary");
    expect(body).toContain("- feat: add login");
    expect(body).toContain("- feat: add signup");
  });

  it("includes completed and failed tasks", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const details = createIssueDetails({ number: "42" });
    const task1 = createTask({ index: 0, text: "Task one", line: 1 });
    const task2 = createTask({ index: 1, text: "Task two", line: 2 });
    const results: DispatchResult[] = [
      { task: task1, success: true },
      { task: task2, success: false, error: "timeout" },
    ];

    const body = await buildPrBody(details, [task1, task2], results, "main", "github", "/tmp/repo");

    expect(body).toContain("## Tasks");
    expect(body).toContain("- [x] Task one");
    expect(body).toContain("- [ ] Task two");
  });

  it("includes labels when present", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const details = createIssueDetails({ number: "10", labels: ["bug", "urgent"] });

    const body = await buildPrBody(details, [], [], "main", "github", "/tmp/repo");

    expect(body).toContain("**Labels:** bug, urgent");
  });

  it("appends GitHub close reference for github datasource", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const details = createIssueDetails({ number: "42" });

    const body = await buildPrBody(details, [], [], "main", "github", "/tmp/repo");

    expect(body).toContain("Closes #42");
    expect(body).not.toContain("Resolves AB#");
  });

  it("appends Azure DevOps close reference for azdevops datasource", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const details = createIssueDetails({ number: "42" });

    const body = await buildPrBody(details, [], [], "main", "azdevops", "/tmp/repo");

    expect(body).toContain("Resolves AB#42");
    expect(body).not.toContain("Closes #");
  });

  it("includes no close reference for md datasource", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    const details = createIssueDetails({ number: "42" });

    const body = await buildPrBody(details, [], [], "main", "md", "/tmp/repo");

    expect(body).not.toContain("Closes #");
    expect(body).not.toContain("Resolves AB#");
  });

  it("handles git log failure gracefully", async () => {
    mockExecFile.mockRejectedValue(new Error("git not found"));

    const details = createIssueDetails({ number: "42" });
    const task = createTask({ text: "Do something" });
    const result: DispatchResult = { task, success: true };

    const body = await buildPrBody(details, [task], [result], "main", "github", "/tmp/repo");

    expect(body).not.toContain("## Summary");
    expect(body).toContain("## Tasks");
    expect(body).toContain("- [x] Do something");
    expect(body).toContain("Closes #42");
  });

  it("omits tasks section when no tasks match results", async () => {
    mockExecFile.mockResolvedValue({ stdout: "feat: init\n" });

    const details = createIssueDetails({ number: "7" });

    const body = await buildPrBody(details, [], [], "main", "github", "/tmp/repo");

    expect(body).not.toContain("## Tasks");
  });
});
