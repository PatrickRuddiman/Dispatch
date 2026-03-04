import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

import { datasource, getCommitMessages } from "../datasources/github.js";

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("github datasource — list", () => {
  it("returns parsed issues from gh issue list", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify([
        { number: 1, title: "Bug", body: "fix it", labels: [{ name: "bug" }], state: "OPEN", url: "https://github.com/o/r/issues/1" },
        { number: 2, title: "Feature", body: "add it", labels: [], state: "OPEN", url: "https://github.com/o/r/issues/2" },
      ]),
    });

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(result[0].number).toBe("1");
    expect(result[0].title).toBe("Bug");
    expect(result[0].labels).toEqual(["bug"]);
    expect(result[1].number).toBe("2");
  });

  it("throws descriptive error when gh returns non-json output", async () => {
    mockExecFile.mockResolvedValue({ stdout: "Not Found\n" });

    await expect(datasource.list({ cwd: "/tmp" })).rejects.toThrow(
      "Failed to parse GitHub CLI output:",
    );
  });
});

describe("github datasource — fetch", () => {
  it("returns issue details with comments", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: "Fix auth",
        body: "broken login",
        labels: [{ name: "bug" }],
        state: "OPEN",
        url: "https://github.com/o/r/issues/42",
        comments: [{ author: { login: "alice" }, body: "on it" }],
      }),
    });

    const result = await datasource.fetch("42", { cwd: "/tmp" });

    expect(result.number).toBe("42");
    expect(result.title).toBe("Fix auth");
    expect(result.comments).toEqual(["**alice:** on it"]);
  });

  it("handles missing comments gracefully", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({ number: 1, title: "T", body: "B", labels: [], state: "OPEN", url: "" }),
    });

    const result = await datasource.fetch("1", { cwd: "/tmp" });
    expect(result.comments).toEqual([]);
  });

  it("throws descriptive error when gh returns non-json output", async () => {
    mockExecFile.mockResolvedValue({ stdout: "ERROR: auth required\n" });

    await expect(datasource.fetch("42", { cwd: "/tmp" })).rejects.toThrow(
      "Failed to parse GitHub CLI output:",
    );
  });
});

describe("github datasource — update", () => {
  it("calls gh issue edit with correct args", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.update("42", "New Title", "New Body", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "edit", "42", "--title", "New Title", "--body", "New Body"],
      { cwd: "/tmp" },
    );
  });
});

describe("github datasource — close", () => {
  it("calls gh issue close", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "close", "42"],
      { cwd: "/tmp" },
    );
  });
});

describe("github datasource — create", () => {
  it("parses issue number from URL", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "https://github.com/org/repo/issues/99\n",
    });

    const result = await datasource.create("New Issue", "Body text", { cwd: "/tmp" });

    expect(result.number).toBe("99");
    expect(result.title).toBe("New Issue");
    expect(result.url).toBe("https://github.com/org/repo/issues/99");
  });

  it("returns 0 when URL does not match pattern", async () => {
    mockExecFile.mockResolvedValue({ stdout: "no-match-url\n" });

    const result = await datasource.create("T", "B", { cwd: "/tmp" });
    expect(result.number).toBe("0");
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
      { cwd: "/tmp" },
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
      { cwd: "/tmp" },
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

    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/tmp" });
  });
});

describe("github datasource — pushBranch", () => {
  it("calls git push with upstream", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.pushBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "dispatch/42-feat"],
      { cwd: "/tmp" },
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
      { cwd: "/tmp" },
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
    mockExecFile.mockResolvedValue({ stdout: "https://github.com/o/r/pull/10\n" });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/10");
  });

  it("returns existing PR URL when already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ stdout: "https://github.com/o/r/pull/5\n" });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://github.com/o/r/pull/5");
  });

  it("throws for non-already-exists errors", async () => {
    mockExecFile.mockRejectedValue(new Error("auth required"));

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" }),
    ).rejects.toThrow("auth required");
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
