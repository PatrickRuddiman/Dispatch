import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockExecFile } from "./fixtures.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("# Test Issue\n\nBody content"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { datasource } from "../datasources/md.js";
import { UnsupportedOperationError } from "../helpers/errors.js";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUsername", () => {
  it("returns slugified git user name", async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "John Doe\n", stderr: "" });
    });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("john-doe");
  });

  it('returns "local" when git returns empty string', async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "  \n", stderr: "" });
    });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("local");
  });

  it('returns "local" when git command fails', async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(new Error("git not found"));
    });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("local");
  });
});

describe("buildBranchName", () => {
  it("builds branch name with username/dispatch/issueNumber-slug pattern", () => {
    const result = datasource.buildBranchName("42", "My Feature", "john-doe");
    expect(result).toBe("john-doe/dispatch/42-my-feature");
  });

  it("builds branch name with provided username", () => {
    const result = datasource.buildBranchName("99", "Some Task", "local");
    expect(result).toBe("local/dispatch/99-some-task");
  });
});

describe("getDefaultBranch", () => {
  it('returns "main"', async () => {
    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
  });
});

describe("supportsGit", () => {
  it("returns false", () => {
    expect(datasource.supportsGit()).toBe(false);
  });
});

describe("git lifecycle", () => {
  it("createAndSwitchBranch throws UnsupportedOperationError", async () => {
    await expect(
      datasource.createAndSwitchBranch("branch", { cwd: "/tmp" }),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  it("switchBranch throws UnsupportedOperationError", async () => {
    await expect(
      datasource.switchBranch("branch", { cwd: "/tmp" }),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  it("pushBranch throws UnsupportedOperationError", async () => {
    await expect(
      datasource.pushBranch("branch", { cwd: "/tmp" }),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  it("commitAllChanges throws UnsupportedOperationError", async () => {
    await expect(
      datasource.commitAllChanges("msg", { cwd: "/tmp" }),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  it("createPullRequest throws UnsupportedOperationError", async () => {
    await expect(
      datasource.createPullRequest(
        "branch",
        "42",
        "title",
        "body",
        { cwd: "/tmp" },
      ),
    ).rejects.toThrow(UnsupportedOperationError);
  });
});

describe("fetch", () => {
  it("resolves a relative issueId against the specs directory", async () => {
    const result = await datasource.fetch("my-issue", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "my-issue.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
    expect(result.number).toBe("my-issue.md");
  });

  it("appends .md extension when missing for relative paths", async () => {
    await datasource.fetch("task-name", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "task-name.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("does not double .md extension for relative paths", async () => {
    await datasource.fetch("task-name.md", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "task-name.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("uses an absolute path directly without prepending specs directory", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue.md";
    await datasource.fetch(absPath, { cwd: "/tmp" });
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(absPath, "utf-8");
  });

  it("appends .md extension to absolute paths when missing", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue";
    await datasource.fetch(absPath, { cwd: "/tmp" });
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(absPath + ".md", "utf-8");
  });
});

describe("update", () => {
  it("resolves a relative issueId against the specs directory", async () => {
    await datasource.update("my-issue", "title", "new body", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "my-issue.md");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(expected, "new body", "utf-8");
  });

  it("uses an absolute path directly without prepending specs directory", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue.md";
    await datasource.update(absPath, "title", "new body", { cwd: "/tmp" });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(absPath, "new body", "utf-8");
  });
});

describe("close", () => {
  it("resolves a relative issueId against the specs directory", async () => {
    await datasource.close("my-issue", { cwd: "/tmp" });
    const expectedDir = join("/tmp", ".dispatch/specs");
    const expectedFile = join(expectedDir, "my-issue.md");
    const expectedArchive = join(expectedDir, "archive");
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expectedArchive, { recursive: true });
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expectedFile, join(expectedArchive, "my-issue.md"));
  });

  it("uses an absolute path directly without prepending specs directory", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue.md";
    await datasource.close(absPath, { cwd: "/tmp" });
    expect(vi.mocked(rename)).toHaveBeenCalledWith(absPath, expect.stringContaining("archive"));
  });
});
