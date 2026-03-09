import { describe, it, expect, vi, beforeEach } from "vitest";

const SHELL = process.platform === "win32";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

const mockOctokit = vi.hoisted(() => ({
  rest: {
    issues: {
      listForRepo: vi.fn(),
      get: vi.fn(),
      listComments: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
      list: vi.fn(),
    },
  },
  paginate: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));
vi.mock("../helpers/auth.js", () => ({
  getGithubOctokit: vi.fn().mockResolvedValue(mockOctokit),
}));
vi.mock("../datasources/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../datasources/index.js")>();
  return {
    ...original,
    getGitRemoteUrl: vi.fn().mockResolvedValue("https://github.com/o/r.git"),
    parseGitHubRemoteUrl: vi.fn().mockReturnValue({ owner: "o", repo: "r" }),
  };
});

import { datasource, getCommitMessages } from "../datasources/github.js";

beforeEach(() => {
  mockExecFile.mockReset();
  mockOctokit.rest.issues.listForRepo.mockReset();
  mockOctokit.rest.issues.get.mockReset();
  mockOctokit.rest.issues.listComments.mockReset();
  mockOctokit.rest.issues.update.mockReset();
  mockOctokit.rest.issues.create.mockReset();
  mockOctokit.rest.pulls.create.mockReset();
  mockOctokit.rest.pulls.list.mockReset();
  mockOctokit.paginate.mockReset();
});

describe("github datasource — list", () => {
  it("returns parsed issues from Octokit", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { number: 1, title: "Bug", body: "fix it", labels: [{ name: "bug" }], state: "open", html_url: "https://github.com/o/r/issues/1" },
      { number: 2, title: "Feature", body: "add it", labels: [], state: "open", html_url: "https://github.com/o/r/issues/2" },
    ]);

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(result[0].number).toBe("1");
    expect(result[0].title).toBe("Bug");
    expect(result[0].labels).toEqual(["bug"]);
    expect(result[1].number).toBe("2");
  });

  it("filters out pull requests from issue list", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { number: 1, title: "Issue", body: "", labels: [], state: "open", html_url: "https://github.com/o/r/issues/1" },
      { number: 2, title: "PR", body: "", labels: [], state: "open", html_url: "https://github.com/o/r/pull/2", pull_request: { url: "..." } },
    ]);

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe("1");
  });
});

describe("github datasource — fetch", () => {
  it("returns issue details with comments", async () => {
    mockOctokit.rest.issues.get.mockResolvedValue({
      data: {
        number: 42,
        title: "Fix auth",
        body: "broken login",
        labels: [{ name: "bug" }],
        state: "open",
        html_url: "https://github.com/o/r/issues/42",
      },
    });
    mockOctokit.paginate.mockResolvedValue(
      [{ user: { login: "alice" }, body: "on it" }],
    );

    const result = await datasource.fetch("42", { cwd: "/tmp" });

    expect(result.number).toBe("42");
    expect(result.title).toBe("Fix auth");
    expect(result.comments).toEqual(["**alice:** on it"]);
  });

  it("handles missing comments gracefully", async () => {
    mockOctokit.rest.issues.get.mockResolvedValue({
      data: { number: 1, title: "T", body: "B", labels: [], state: "open", html_url: "" },
    });
    mockOctokit.paginate.mockResolvedValue([]);

    const result = await datasource.fetch("1", { cwd: "/tmp" });
    expect(result.comments).toEqual([]);
  });

  it("handles null comment body without producing 'null' string", async () => {
    mockOctokit.rest.issues.get.mockResolvedValue({
      data: { number: 1, title: "T", body: "B", labels: [], state: "open", html_url: "" },
    });
    mockOctokit.paginate.mockResolvedValue(
      [{ user: { login: "bob" }, body: null }],
    );

    const result = await datasource.fetch("1", { cwd: "/tmp" });
    expect(result.comments).toEqual(["**bob:** "]);
  });
});

describe("github datasource — update", () => {
  it("calls octokit issues.update with correct args", async () => {
    mockOctokit.rest.issues.update.mockResolvedValue({ data: {} });

    await datasource.update("42", "New Title", "New Body", { cwd: "/tmp" });

    expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 42,
      title: "New Title",
      body: "New Body",
    });
  });
});

describe("github datasource — close", () => {
  it("calls octokit issues.update with state closed", async () => {
    mockOctokit.rest.issues.update.mockResolvedValue({ data: {} });

    await datasource.close("42", { cwd: "/tmp" });

    expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 42,
      state: "closed",
    });
  });
});

describe("github datasource — create", () => {
  it("creates issue and returns IssueDetails", async () => {
    mockOctokit.rest.issues.create.mockResolvedValue({
      data: {
        number: 99,
        title: "New Issue",
        body: "Body text",
        labels: [],
        state: "open",
        html_url: "https://github.com/o/r/issues/99",
      },
    });

    const result = await datasource.create("New Issue", "Body text", { cwd: "/tmp" });

    expect(result.number).toBe("99");
    expect(result.title).toBe("New Issue");
    expect(result.url).toBe("https://github.com/o/r/issues/99");
  });
});

describe("github datasource — getDefaultBranch", () => {
  it("returns branch from symbolic-ref", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/develop\n" });

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("develop");
  });

  it("falls back to main when symbolic-ref fails", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
  });

  it("falls back to master when both fail", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal"))
      .mockRejectedValueOnce(new Error("fatal"));

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("master");
  });

  it("rejects branch names containing spaces", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/my branch\n" });

    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name",
    );
  });

  it("rejects branch names containing shell metacharacters", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/$(whoami)\n" });

    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name",
    );
  });

  it("rejects branch names exceeding 255 characters", async () => {
    const longName = "a".repeat(256);
    mockExecFile.mockResolvedValue({ stdout: `refs/remotes/origin/${longName}\n` });

    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name",
    );
  });

  it("rejects empty branch names", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/\n" });

    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name",
    );
  });
});

describe("github datasource — buildBranchName", () => {
  it("builds <username>/dispatch/<number>-<slug>", () => {
    const result = datasource.buildBranchName("42", "Add User Auth", "jdoe");
    expect(result).toBe("jdoe/dispatch/42-add-user-auth");
  });

  it("falls back to 'unknown' when username is omitted", () => {
    const result = datasource.buildBranchName("42", "Add User Auth");
    expect(result).toBe("unknown/dispatch/42-add-user-auth");
  });
});

describe("github datasource — createAndSwitchBranch", () => {
  it("creates and checks out a new branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
  });

  it("falls back to checkout if branch already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      "git",
      ["checkout", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
  });

  it("prunes stale worktrees and retries checkout when branch is worktree-locked", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal: a branch named 'dispatch/42-feat' already exists"))
      .mockRejectedValueOnce(new Error("fatal: 'dispatch/42-feat' is already used by worktree at '/tmp/stale-worktree'"))
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["checkout", "-b", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["checkout", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "prune"],
      { cwd: "/tmp", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      4,
      "git",
      ["checkout", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
  });

  it("throws for non-already-exists errors", async () => {
    mockExecFile.mockRejectedValue(new Error("permission denied"));

    await expect(
      datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" }),
    ).rejects.toThrow("permission denied");
  });
});

describe("github datasource — switchBranch", () => {
  it("calls git checkout", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.switchBranch("main", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/tmp", shell: SHELL });
  });
});

describe("github datasource — pushBranch", () => {
  it("calls git push with upstream", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.pushBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
  });
});

describe("github datasource — commitAllChanges", () => {
  it("stages and commits when there are changes", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" }) // git add
      .mockResolvedValueOnce({ stdout: " 2 files changed\n" }) // git diff --cached --stat
      .mockResolvedValueOnce({ stdout: "" }); // git commit

    await datasource.commitAllChanges("feat: update", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      "git",
      ["commit", "-m", "feat: update"],
      { cwd: "/tmp", shell: SHELL },
    );
  });

  it("skips commit when no changes staged", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" }) // git add
      .mockResolvedValueOnce({ stdout: "" }); // git diff --cached --stat (empty)

    await datasource.commitAllChanges("feat: update", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe("github datasource — createPullRequest", () => {
  it("creates PR and returns URL", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });
    mockOctokit.rest.pulls.create.mockResolvedValue({
      data: { html_url: "https://github.com/o/r/pull/10" },
    });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/10");
  });

  it("returns existing PR URL when already exists", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });
    const error = Object.assign(
      new Error("Validation Failed"),
      { status: 422, response: { data: { errors: [{ message: "A pull request already exists" }] } } },
    );
    mockOctokit.rest.pulls.create.mockRejectedValue(error);
    mockOctokit.rest.pulls.list.mockResolvedValue({
      data: [{ html_url: "https://github.com/o/r/pull/5" }],
    });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/5");
  });

  it("throws for non-already-exists errors", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });
    mockOctokit.rest.pulls.create.mockRejectedValue(new Error("auth required"));

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" }),
    ).rejects.toThrow("auth required");
  });

  it("uses default body when body is empty string", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });
    mockOctokit.rest.pulls.create.mockResolvedValue({
      data: { html_url: "https://github.com/o/r/pull/11" },
    });

    const url = await datasource.createPullRequest(
      "dispatch/99-bugfix", "99", "fix: resolve crash", "", { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/11");
    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Closes #99" }),
    );
  });

  it("passes provided body to pulls.create", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });
    mockOctokit.rest.pulls.create.mockResolvedValue({
      data: { html_url: "https://github.com/o/r/pull/12" },
    });

    const customBody = "## Summary\n\nImplemented user auth\n\nCloses #42";
    const url = await datasource.createPullRequest(
      "dispatch/42-feature", "42", "feat: add user auth", customBody, { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/12");
    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: customBody }),
    );
  });

  it("passes multiline markdown body through to pulls.create", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main\n" });
    mockOctokit.rest.pulls.create.mockResolvedValue({
      data: { html_url: "https://github.com/o/r/pull/13" },
    });

    const multilineBody = [
      "## Summary",
      "",
      "- feat: add login",
      "- feat: add signup",
      "",
      "## Tasks",
      "",
      "- [x] Implement login",
      "- [x] Implement signup",
      "",
      "Closes #42",
    ].join("\n");

    const url = await datasource.createPullRequest(
      "dispatch/42-feature", "42", "feat: add user auth", multilineBody, { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/13");
    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: multilineBody }),
    );
  });
});

describe("getCommitMessages", () => {
  it("returns commit messages", async () => {
    mockExecFile.mockResolvedValue({ stdout: "feat: a\nfix: b\n" });

    const msgs = await getCommitMessages("main", "/tmp");

    expect(msgs).toEqual(["feat: a", "fix: b"]);
  });

  it("returns empty array on failure", async () => {
    mockExecFile.mockRejectedValue(new Error("fatal"));

    const msgs = await getCommitMessages("main", "/tmp");

    expect(msgs).toEqual([]);
  });
});
