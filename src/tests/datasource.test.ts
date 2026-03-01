import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdtemp, rm, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatasourceName } from "../datasources/interface.js";
import { DATASOURCE_NAMES, getDatasource } from "../datasources/index.js";
import { validateConfigValue } from "../config.js";

// ─── MD datasource — list ────────────────────────────────────────────

describe("MD datasource — list", () => {
  const md = getDatasource("md");
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when specs directory does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const result = await md.list({ cwd: tmpDir });
    expect(result).toEqual([]);
  });

  it("returns empty array when specs directory is empty", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await mkdir(join(tmpDir, ".dispatch", "specs"), { recursive: true });
    const result = await md.list({ cwd: tmpDir });
    expect(result).toEqual([]);
  });

  it("lists all .md files sorted alphabetically", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "b-feature.md"), "# B Feature", "utf-8");
    await writeFile(join(specsDir, "a-feature.md"), "# A Feature", "utf-8");
    const result = await md.list({ cwd: tmpDir });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.number)).toEqual(["a-feature.md", "b-feature.md"]);
  });

  it("ignores non-.md files", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "spec.md"), "# Spec", "utf-8");
    await writeFile(join(specsDir, "notes.txt"), "some notes", "utf-8");
    const result = await md.list({ cwd: tmpDir });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe("spec.md");
  });

  it("populates IssueDetails fields correctly", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "my-spec.md"), "# My Title\n\nBody content", "utf-8");
    const result = await md.list({ cwd: tmpDir });
    expect(result).toHaveLength(1);
    const issue = result[0];
    expect(issue.number).toBe("my-spec.md");
    expect(issue.title).toBe("My Title");
    expect(issue.body).toContain("Body content");
    expect(issue.labels).toEqual([]);
    expect(issue.state).toBe("open");
    expect(issue.comments).toEqual([]);
    expect(issue.acceptanceCriteria).toBe("");
  });
});

// ─── MD datasource — fetch ───────────────────────────────────────────

describe("MD datasource — fetch", () => {
  const md = getDatasource("md");
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("fetches a file by name with .md extension", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "my-spec.md"), "# My Title\n\nBody here", "utf-8");
    const result = await md.fetch("my-spec.md", { cwd: tmpDir });
    expect(result.title).toBe("My Title");
    expect(result.body).toContain("Body here");
  });

  it("fetches a file by name without .md extension", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "my-spec.md"), "# Feature\n\nContent", "utf-8");
    const result = await md.fetch("my-spec", { cwd: tmpDir });
    expect(result.title).toBe("Feature");
    expect(result.body).toContain("Content");
  });

  it("extracts title from first H1 heading", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "# Feature Title\n\nBody", "utf-8");
    const result = await md.fetch("test", { cwd: tmpDir });
    expect(result.title).toBe("Feature Title");
  });

  it("falls back to filename as title when no H1 heading", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "my-spec.md"), "No heading here\n\nJust content", "utf-8");
    const result = await md.fetch("my-spec", { cwd: tmpDir });
    expect(result.title).toBe("my-spec");
  });

  it("throws when file does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await expect(md.fetch("nonexistent", { cwd: tmpDir })).rejects.toThrow();
  });
});

// ─── MD datasource — update ──────────────────────────────────────────

describe("MD datasource — update", () => {
  const md = getDatasource("md");
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes new body content to the file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "old content", "utf-8");
    await md.update("test.md", "ignored title", "new content", { cwd: tmpDir });
    const content = await readFile(join(specsDir, "test.md"), "utf-8");
    expect(content).toBe("new content");
  });

  it("appends .md extension when not provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "old content", "utf-8");
    await md.update("test", "ignored", "updated content", { cwd: tmpDir });
    const content = await readFile(join(specsDir, "test.md"), "utf-8");
    expect(content).toBe("updated content");
  });
});

// ─── MD datasource — close ──────────────────────────────────────────

describe("MD datasource — close", () => {
  const md = getDatasource("md");
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("moves file to archive subdirectory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "to-close.md"), "content", "utf-8");
    await md.close("to-close.md", { cwd: tmpDir });
    await expect(readFile(join(specsDir, "to-close.md"), "utf-8")).rejects.toThrow();
    const archiveContent = await readFile(join(specsDir, "archive", "to-close.md"), "utf-8");
    expect(archiveContent).toBe("content");
  });

  it("creates archive directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "feature.md"), "spec content", "utf-8");
    await md.close("feature.md", { cwd: tmpDir });
    const archiveEntries = await readdir(join(specsDir, "archive"));
    expect(archiveEntries).toContain("feature.md");
  });
});

// ─── MD datasource — create ──────────────────────────────────────────

describe("MD datasource — create", () => {
  const md = getDatasource("md");
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates a new .md file with slugified name", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    const result = await md.create("My New Feature", "body content", { cwd: tmpDir });
    expect(result.number).toBe("my-new-feature.md");
    const content = await readFile(join(specsDir, "my-new-feature.md"), "utf-8");
    expect(content).toBe("body content");
  });

  it("creates specs directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const result = await md.create("Auto Dir", "auto body", { cwd: tmpDir });
    expect(result.number).toBe("auto-dir.md");
    const content = await readFile(join(tmpDir, ".dispatch", "specs", "auto-dir.md"), "utf-8");
    expect(content).toBe("auto body");
  });

  it("returns correct IssueDetails for created file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const result = await md.create("Test Title", "body", { cwd: tmpDir });
    expect(result.title).toBe("test-title");
    expect(result.body).toBe("body");
    expect(result.state).toBe("open");
    expect(result.labels).toEqual([]);
  });
});

// ─── Config validation — provider and source ─────────────────────────

describe("validateConfigValue — datasource names", () => {
  it("accepts 'md' as a valid source", () => {
    expect(validateConfigValue("source", "md")).toBe(null);
  });

  it("accepts 'github' as a valid source", () => {
    expect(validateConfigValue("source", "github")).toBe(null);
  });

  it("accepts 'azdevops' as a valid source", () => {
    expect(validateConfigValue("source", "azdevops")).toBe(null);
  });

  it("rejects unknown source names", () => {
    for (const name of ["jira", "linear", "bitbucket"]) {
      const result = validateConfigValue("source", name);
      expect(result).not.toBe(null);
      expect(result).toContain("Invalid source");
    }
  });

  it("rejects empty string as source", () => {
    const result = validateConfigValue("source", "");
    expect(result).not.toBe(null);
  });
});

// ─── DatasourceName and registry ─────────────────────────────────────

describe("DatasourceName and registry", () => {
  it("DATASOURCE_NAMES includes all three datasource types", () => {
    expect(DATASOURCE_NAMES).toContain("github");
    expect(DATASOURCE_NAMES).toContain("azdevops");
    expect(DATASOURCE_NAMES).toContain("md");
  });

  it("DATASOURCE_NAMES has exactly three entries", () => {
    expect(DATASOURCE_NAMES).toHaveLength(3);
  });

  it("getDatasource returns an object with the correct name for each datasource", () => {
    for (const name of DATASOURCE_NAMES) {
      const ds = getDatasource(name);
      expect(ds.name).toBe(name);
    }
  });

  it("getDatasource returns objects that satisfy the Datasource interface", () => {
    for (const name of DATASOURCE_NAMES) {
      const ds = getDatasource(name);
      expect(typeof ds.list).toBe("function");
      expect(typeof ds.fetch).toBe("function");
      expect(typeof ds.update).toBe("function");
      expect(typeof ds.close).toBe("function");
      expect(typeof ds.create).toBe("function");
      expect(typeof ds.getDefaultBranch).toBe("function");
      expect(typeof ds.buildBranchName).toBe("function");
      expect(typeof ds.createAndSwitchBranch).toBe("function");
      expect(typeof ds.switchBranch).toBe("function");
      expect(typeof ds.pushBranch).toBe("function");
      expect(typeof ds.commitAllChanges).toBe("function");
      expect(typeof ds.createPullRequest).toBe("function");
    }
  });

  it("getDatasource throws for unknown datasource name", () => {
    expect(() => getDatasource("invalid" as DatasourceName)).toThrow("Unknown datasource");
  });
});
