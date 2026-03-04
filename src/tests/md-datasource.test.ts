import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockExecFile } from "./fixtures.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { datasource } from "../datasources/md.js";
import { UnsupportedOperationError } from "../helpers/errors.js";
import { execFile } from "node:child_process";

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
