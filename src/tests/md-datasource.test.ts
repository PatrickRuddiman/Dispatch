import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockExecFile } from "./fixtures.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { datasource } from "../datasources/md.js";
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

describe("git lifecycle no-ops", () => {
  it("createAndSwitchBranch resolves to undefined", async () => {
    const result = await datasource.createAndSwitchBranch("branch", {
      cwd: "/tmp",
    });
    expect(result).toBeUndefined();
  });

  it("switchBranch resolves to undefined", async () => {
    const result = await datasource.switchBranch("branch", { cwd: "/tmp" });
    expect(result).toBeUndefined();
  });

  it("pushBranch resolves to undefined", async () => {
    const result = await datasource.pushBranch("branch", { cwd: "/tmp" });
    expect(result).toBeUndefined();
  });

  it("commitAllChanges resolves to undefined", async () => {
    const result = await datasource.commitAllChanges("msg", { cwd: "/tmp" });
    expect(result).toBeUndefined();
  });

  it('createPullRequest resolves to ""', async () => {
    const result = await datasource.createPullRequest(
      "branch",
      "42",
      "title",
      "body",
      { cwd: "/tmp" },
    );
    expect(result).toBe("");
  });
});
