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

vi.mock("glob", () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
  saveConfig: vi.fn().mockResolvedValue(undefined),
}));

import { datasource } from "../datasources/md.js";
import { execFile } from "node:child_process";
import { readFile, writeFile, readdir, mkdir, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { glob } from "glob";
import { loadConfig, saveConfig } from "../config.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list", () => {
  it("returns md files from default specs directory when no pattern given", async () => {
    vi.mocked(readdir).mockResolvedValue(["b.md", "a.md", "readme.txt"] as any);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith("a.md")) return "# Alpha\nContent A";
      if (String(filePath).endsWith("b.md")) return "# Beta\nContent B";
      return "";
    });

    const results = await datasource.list({ cwd: "/tmp/project" });

    expect(readdir).toHaveBeenCalledWith(expect.stringContaining(join(".dispatch", "specs")));
    expect(results).toHaveLength(2);
    expect(results[0].number).toBe("a.md");
    expect(results[0].title).toBe("Alpha");
    expect(results[1].number).toBe("b.md");
    expect(results[1].title).toBe("Beta");
  });

  it("uses glob to expand pattern when opts.pattern is provided", async () => {
    vi.mocked(glob).mockResolvedValue(["/tmp/project/docs/one.md", "/tmp/project/docs/two.md"] as any);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith("one.md")) return "# One\nContent 1";
      if (String(filePath).endsWith("two.md")) return "# Two\nContent 2";
      return "";
    });

    const results = await datasource.list({ cwd: "/tmp/project", pattern: "docs/**/*.md" });

    expect(glob).toHaveBeenCalledWith("docs/**/*.md", { cwd: "/tmp/project", absolute: true });
    expect(results).toHaveLength(2);
    expect(results[0].number).toBe("one.md");
    expect(results[0].title).toBe("One");
    expect(results[1].number).toBe("two.md");
    expect(results[1].title).toBe("Two");
  });

  it("filters out non-.md files from glob results", async () => {
    vi.mocked(glob).mockResolvedValue(["/tmp/a.md", "/tmp/b.txt"] as any);
    vi.mocked(readFile).mockResolvedValue("# Doc\nBody");

    const results = await datasource.list({ cwd: "/tmp", pattern: "*.{md,txt}" });

    expect(results).toHaveLength(1);
    expect(results[0].number).toBe("a.md");
  });

  it("returns empty array when glob matches no files", async () => {
    vi.mocked(glob).mockResolvedValue([] as any);

    const results = await datasource.list({ cwd: "/tmp", pattern: "nothing/*.md" });

    expect(results).toHaveLength(0);
  });

  it("extracts numeric ID prefix as the number field for {id}-{slug}.md files", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-feature-a.md", "2-feature-b.md"] as any);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith("1-feature-a.md")) return "# Feature A\nContent A";
      if (String(filePath).endsWith("2-feature-b.md")) return "# Feature B\nContent B";
      return "";
    });

    const results = await datasource.list({ cwd: "/tmp/project" });

    expect(results).toHaveLength(2);
    expect(results[0].number).toBe("1");
    expect(results[0].title).toBe("Feature A");
    expect(results[1].number).toBe("2");
    expect(results[1].title).toBe("Feature B");
  });

  it("returns empty array when default specs directory does not exist", async () => {
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

    const results = await datasource.list({ cwd: "/tmp" });

    expect(results).toHaveLength(0);
  });

  it("expands an absolute glob pattern", async () => {
    vi.mocked(glob).mockResolvedValue(["/home/user/docs/one.md", "/home/user/docs/two.md"] as any);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith("one.md")) return "# One\nContent 1";
      if (String(filePath).endsWith("two.md")) return "# Two\nContent 2";
      return "";
    });

    const results = await datasource.list({ cwd: "/tmp/project", pattern: "/home/user/docs/*.md" });

    expect(glob).toHaveBeenCalledWith("/home/user/docs/*.md", { cwd: "/tmp/project", absolute: true });
    expect(results).toHaveLength(2);
    expect(results[0].number).toBe("one.md");
    expect(results[1].number).toBe("two.md");
  });

  it("expands a parent-relative glob pattern", async () => {
    vi.mocked(glob).mockResolvedValue(["/tmp/shared-specs/task.md"] as any);
    vi.mocked(readFile).mockResolvedValue("# Shared Task\nBody");

    const results = await datasource.list({ cwd: "/tmp/project", pattern: "../shared-specs/*.md" });

    expect(glob).toHaveBeenCalledWith("../shared-specs/*.md", { cwd: "/tmp/project", absolute: true });
    expect(results).toHaveLength(1);
    expect(results[0].number).toBe("task.md");
    expect(results[0].title).toBe("Shared Task");
  });

  it("accepts an array of glob patterns", async () => {
    vi.mocked(glob).mockResolvedValue(["/tmp/a.md", "/tmp/b.md"] as any);
    vi.mocked(readFile).mockResolvedValue("# Doc\nBody");

    const results = await datasource.list({ cwd: "/tmp", pattern: ["docs/*.md", "specs/*.md"] });

    expect(glob).toHaveBeenCalledWith(["docs/*.md", "specs/*.md"], { cwd: "/tmp", absolute: true });
    expect(results).toHaveLength(2);
  });
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

  it("extracts file-{id} from an absolute Unix file path with {id}-{slug}.md pattern", () => {
    const result = datasource.buildBranchName(
      "/home/user/project/.dispatch/specs/42-batch-updates.md",
      "Batch Updates",
      "john-doe",
    );
    expect(result).toBe("john-doe/dispatch/file-42-batch-updates");
  });

  it("falls back to file-{slugified-basename} for paths without numeric prefix", () => {
    const result = datasource.buildBranchName(
      "/home/user/project/.dispatch/specs/my-design-doc.md",
      "My Design Doc",
      "john-doe",
    );
    expect(result).toBe("john-doe/dispatch/file-my-design-doc-my-design-doc");
  });

  it("extracts file-{id} from a relative path with {id}-{slug}.md pattern", () => {
    const result = datasource.buildBranchName(
      "specs/7-add-logging.md",
      "Add Logging",
      "alice",
    );
    expect(result).toBe("alice/dispatch/file-7-add-logging");
  });

  it("handles Windows-style backslash path separators", () => {
    const result = datasource.buildBranchName(
      "C:\\Users\\dev\\specs\\10-fix-bug.md",
      "Fix Bug",
      "bob",
    );
    expect(result).toBe("bob/dispatch/file-10-fix-bug");
  });

  it("preserves plain numeric ID without path separators unchanged", () => {
    const result = datasource.buildBranchName("7", "Feature Request", "local");
    expect(result).toBe("local/dispatch/7-feature-request");
  });
});

describe("getDefaultBranch", () => {
  it("detects default branch via git symbolic-ref", async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "refs/remotes/origin/main\n", stderr: "" });
    });
    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
  });

  it('falls back to "main" when symbolic-ref fails and main exists', async () => {
    let callCount = 0;
    mockExecFile(vi.mocked(execFile), (_cmd, args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error("not a git repo"));
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    });
    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
  });

  it('falls back to "master" when both symbolic-ref and main check fail', async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(new Error("failed"));
    });
    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("master");
  });
});

describe("supportsGit", () => {
  it("returns true", () => {
    expect(datasource.supportsGit()).toBe(true);
  });
});

describe("git lifecycle", () => {
  it("createAndSwitchBranch runs git checkout -b", async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "", stderr: "" });
    });
    await datasource.createAndSwitchBranch("user/dispatch/1-feat", { cwd: "/tmp" });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "user/dispatch/1-feat"],
      expect.objectContaining({ cwd: "/tmp" }),
      expect.any(Function),
    );
  });

  it("switchBranch runs git checkout", async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "", stderr: "" });
    });
    await datasource.switchBranch("main", { cwd: "/tmp" });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "main"],
      expect.objectContaining({ cwd: "/tmp" }),
      expect.any(Function),
    );
  });

  it("pushBranch is a no-op", async () => {
    await datasource.pushBranch("branch", { cwd: "/tmp" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("commitAllChanges stages and commits", async () => {
    mockExecFile(vi.mocked(execFile), (_cmd, args, _opts, cb) => {
      if (args && args[0] === "diff") {
        cb(null, { stdout: " file.ts | 1 +\n", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    });
    await datasource.commitAllChanges("feat: test", { cwd: "/tmp" });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["add", "-A"],
      expect.objectContaining({ cwd: "/tmp" }),
      expect.any(Function),
    );
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "feat: test"],
      expect.objectContaining({ cwd: "/tmp" }),
      expect.any(Function),
    );
  });

  it("createPullRequest returns empty string", async () => {
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

describe("fetch", () => {
  it("resolves a plain issueId against the specs directory", async () => {
    const result = await datasource.fetch("my-issue", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "my-issue.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
    expect(result.number).toBe("my-issue.md");
  });

  it("appends .md extension when missing", async () => {
    await datasource.fetch("task-name", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "task-name.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("does not double .md extension", async () => {
    await datasource.fetch("task-name.md", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "task-name.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("uses an absolute path directly without prepending specs directory", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue.md";
    const result = await datasource.fetch(absPath, { cwd: "/tmp" });
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(absPath, "utf-8");
    expect(result.number).toBe("my-issue.md");
    expect(result.url).toBe(join(dirname(absPath), "my-issue.md"));
  });

  it("appends .md extension to absolute paths when missing", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue";
    await datasource.fetch(absPath, { cwd: "/tmp" });
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(absPath + ".md", "utf-8");
  });

  it("resolves a relative path with ./ against cwd", async () => {
    await datasource.fetch("./my-issue.md", { cwd: "/tmp" });
    const expected = resolve("/tmp", "./my-issue.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("resolves a relative path with ../ against cwd", async () => {
    await datasource.fetch("../specs/my-issue.md", { cwd: "/tmp/project" });
    const expected = resolve("/tmp/project", "../specs/my-issue.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("resolves a subfolder relative path against cwd", async () => {
    await datasource.fetch("subfolder/task.md", { cwd: "/tmp" });
    const expected = resolve("/tmp", "subfolder/task.md");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(expected, "utf-8");
  });

  it("resolves a numeric-only ID by scanning for {id}-*.md in specs directory", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-my-feature.md", "2-other-task.md"] as any);
    vi.mocked(readFile).mockResolvedValue("# My Feature\n\nBody content");

    const result = await datasource.fetch("1", { cwd: "/tmp" });

    expect(readdir).toHaveBeenCalledWith(join("/tmp", ".dispatch/specs"));
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      join("/tmp", ".dispatch/specs", "1-my-feature.md"),
      "utf-8",
    );
    expect(result.number).toBe("1");
    expect(result.title).toBe("My Feature");
  });

  it("falls through to resolveFilePath when numeric ID has no matching file", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-my-feature.md"] as any);
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    await expect(datasource.fetch("99", { cwd: "/tmp" })).rejects.toThrow();
  });

  it("does not use numeric scan for non-numeric IDs", async () => {
    vi.mocked(readFile).mockResolvedValue("# Test\n\nBody");

    await datasource.fetch("my-issue", { cwd: "/tmp" });

    expect(readdir).not.toHaveBeenCalled();
  });

  it("extracts numeric ID prefix from {id}-{slug}.md filename as number", async () => {
    vi.mocked(readFile).mockResolvedValue("# Dark Mode\n\nAdd dark mode support");

    const result = await datasource.fetch("3-add-dark-mode.md", { cwd: "/tmp" });

    expect(result.number).toBe("3");
    expect(result.title).toBe("Dark Mode");
  });
});

describe("update", () => {
  it("resolves a plain issueId against the specs directory", async () => {
    await datasource.update("my-issue", "title", "new body", { cwd: "/tmp" });
    const expected = join("/tmp", ".dispatch/specs", "my-issue.md");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(expected, "new body", "utf-8");
  });

  it("uses an absolute path directly without prepending specs directory", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue.md";
    await datasource.update(absPath, "title", "new body", { cwd: "/tmp" });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(absPath, "new body", "utf-8");
  });

  it("resolves a relative path with ./ against cwd", async () => {
    await datasource.update("./my-issue.md", "title", "new body", { cwd: "/tmp" });
    const expected = resolve("/tmp", "./my-issue.md");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(expected, "new body", "utf-8");
  });

  it("resolves a subfolder relative path against cwd", async () => {
    await datasource.update("subfolder/task.md", "title", "new body", { cwd: "/tmp" });
    const expected = resolve("/tmp", "subfolder/task.md");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(expected, "new body", "utf-8");
  });

  it("resolves a relative path with ../ against cwd", async () => {
    await datasource.update("../specs/my-issue.md", "title", "new body", { cwd: "/tmp/project" });
    const expected = resolve("/tmp/project", "../specs/my-issue.md");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(expected, "new body", "utf-8");
  });

  it("resolves a numeric-only ID by scanning for {id}-*.md in specs directory", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-my-feature.md", "2-other-task.md"] as any);

    await datasource.update("1", "title", "new body", { cwd: "/tmp" });

    expect(readdir).toHaveBeenCalledWith(join("/tmp", ".dispatch/specs"));
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join("/tmp", ".dispatch/specs", "1-my-feature.md"),
      "new body",
      "utf-8",
    );
  });

  it("falls through to resolveFilePath when numeric ID has no matching file", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-my-feature.md"] as any);

    await datasource.update("99", "title", "new body", { cwd: "/tmp" });

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join("/tmp", ".dispatch/specs", "99.md"),
      "new body",
      "utf-8",
    );
  });
});

describe("close", () => {
  it("resolves a plain issueId against the specs directory", async () => {
    await datasource.close("my-issue", { cwd: "/tmp" });
    const expectedFile = join("/tmp", ".dispatch/specs", "my-issue.md");
    const expectedArchive = join("/tmp", ".dispatch/specs", "archive");
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expectedArchive, { recursive: true });
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expectedFile, join(expectedArchive, "my-issue.md"));
  });

  it("uses an absolute path directly without prepending specs directory", async () => {
    const absPath = "/home/user/project/.dispatch/specs/my-issue.md";
    await datasource.close(absPath, { cwd: "/tmp" });
    const expectedArchive = join(dirname(absPath), "archive");
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expectedArchive, { recursive: true });
    expect(vi.mocked(rename)).toHaveBeenCalledWith(absPath, join(expectedArchive, "my-issue.md"));
  });

  it("resolves a relative path with ./ against cwd", async () => {
    await datasource.close("./my-issue.md", { cwd: "/tmp" });
    const expected = resolve("/tmp", "./my-issue.md");
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expected, expect.stringContaining("archive"));
  });

  it("resolves a subfolder relative path against cwd", async () => {
    await datasource.close("subfolder/task.md", { cwd: "/tmp" });
    const expected = resolve("/tmp", "subfolder/task.md");
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expected, expect.stringContaining("archive"));
  });

  it("resolves a relative path with ../ against cwd", async () => {
    await datasource.close("../specs/my-issue.md", { cwd: "/tmp/project" });
    const expected = resolve("/tmp/project", "../specs/my-issue.md");
    const archiveDest = join(dirname(expected), "archive", "my-issue.md");
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expected, archiveDest);
  });

  it("resolves a numeric-only ID by scanning for {id}-*.md in specs directory", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-my-feature.md", "2-other-task.md"] as any);

    await datasource.close("1", { cwd: "/tmp" });

    expect(readdir).toHaveBeenCalledWith(join("/tmp", ".dispatch/specs"));
    const expectedFile = join("/tmp", ".dispatch/specs", "1-my-feature.md");
    const expectedArchive = join("/tmp", ".dispatch/specs", "archive");
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expectedArchive, { recursive: true });
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expectedFile, join(expectedArchive, "1-my-feature.md"));
  });

  it("falls through to resolveFilePath when numeric ID has no matching file", async () => {
    vi.mocked(readdir).mockResolvedValue(["1-my-feature.md"] as any);

    await datasource.close("99", { cwd: "/tmp" });

    const expectedFile = join("/tmp", ".dispatch/specs", "99.md");
    const expectedArchive = join("/tmp", ".dispatch/specs", "archive");
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expectedArchive, { recursive: true });
    expect(vi.mocked(rename)).toHaveBeenCalledWith(expectedFile, join(expectedArchive, "99.md"));
  });
});

describe("create", () => {
  it("creates a file with auto-incremented ID prefix defaulting to 1", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(saveConfig).mockResolvedValue(undefined);

    const result = await datasource.create("My Feature", "# My Feature\n\nbody content", { cwd: "/tmp" });

    expect(result.number).toBe("1");
    expect(result.title).toBe("My Feature");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join("/tmp", ".dispatch/specs", "1-my-feature.md"),
      "# My Feature\n\nbody content",
      "utf-8",
    );
    expect(loadConfig).toHaveBeenCalledWith(join("/tmp", ".dispatch"));
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ nextIssueId: 2 }),
      join("/tmp", ".dispatch"),
    );
  });

  it("uses existing nextIssueId from config", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ nextIssueId: 5 });
    vi.mocked(saveConfig).mockResolvedValue(undefined);

    const result = await datasource.create("Another Task", "body", { cwd: "/tmp" });

    expect(result.number).toBe("5");
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join("/tmp", ".dispatch/specs", "5-another-task.md"),
      "body",
      "utf-8",
    );
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ nextIssueId: 6 }),
      join("/tmp", ".dispatch"),
    );
  });

  it("increments the counter sequentially across calls", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({ nextIssueId: 1 });
    vi.mocked(saveConfig).mockResolvedValue(undefined);

    await datasource.create("First", "body1", { cwd: "/tmp" });

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ nextIssueId: 2 }),
      join("/tmp", ".dispatch"),
    );
  });
});
