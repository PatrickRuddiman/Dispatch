import { describe, it, expect, vi, beforeEach } from "vitest";

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
    vi.mocked(execFile).mockImplementation(
      ((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, { stdout: "John Doe\n", stderr: "" });
      }) as any,
    );
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("john-doe");
  });

  it('returns "local" when git returns empty string', async () => {
    vi.mocked(execFile).mockImplementation(
      ((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, { stdout: "  \n", stderr: "" });
      }) as any,
    );
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("local");
  });

  it('returns "local" when git command fails', async () => {
    vi.mocked(execFile).mockImplementation(
      ((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error("git not found"));
      }) as any,
    );
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("local");
  });
});

describe("buildBranchName", () => {
  it("builds branch name with username/dispatch/issueNumber-slug pattern", () => {
    const result = datasource.buildBranchName(
      "42",
      "Add login page",
      "john-doe",
    );
    expect(result).toBe("john-doe/dispatch/42-add-login-page");
  });

  it("truncates slug to 50 characters", () => {
    const longTitle =
      "This is a very long title that should definitely be truncated to fifty characters maximum";
    const result = datasource.buildBranchName("99", longTitle, "user");
    const slug = result.split("/dispatch/")[1]; // "99-<slug>"
    const titleSlug = slug.split("-").slice(1).join("-"); // remove "99-" prefix
    expect(titleSlug.length).toBeLessThanOrEqual(50);
    expect(result).toMatch(/^user\/dispatch\/99-.+/);
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
