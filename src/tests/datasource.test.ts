import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdtemp, rm, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatasourceName } from "../datasources/interface.js";
import { DATASOURCE_NAMES, getDatasource, parseAzDevOpsRemoteUrl } from "../datasources/index.js";
import { validateConfigValue } from "../config.js";
import { extractTitle } from "../datasources/md.js";

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

  it("extracts title from first content line when no H1 heading", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "my-spec.md"), "No heading here\n\nJust content", "utf-8");
    const result = await md.fetch("my-spec", { cwd: tmpDir });
    expect(result.title).toBe("No heading here");
  });

  it("strips leading markdown prefixes from title", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "## Subheading Title\n\nBody", "utf-8");
    const result = await md.fetch("test", { cwd: tmpDir });
    expect(result.title).toBe("Subheading Title");
  });

  it("truncates long first lines at word boundary", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    const longLine = "This is a very long description that should be truncated at a word boundary because it exceeds eighty characters in total length";
    await writeFile(join(specsDir, "long.md"), longLine, "utf-8");
    const result = await md.fetch("long", { cwd: tmpDir });
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(longLine.startsWith(result.title)).toBe(true);
    expect(result.title).not.toMatch(/\s$/);
  });

  it("skips blank lines to find first meaningful content", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "\n\n\nActual content here", "utf-8");
    const result = await md.fetch("test", { cwd: tmpDir });
    expect(result.title).toBe("Actual content here");
  });

  it("strips blockquote prefix from title", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "> Quoted description text", "utf-8");
    const result = await md.fetch("test", { cwd: tmpDir });
    expect(result.title).toBe("Quoted description text");
  });

  it("strips list marker prefix from title", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "test.md"), "- List item as description", "utf-8");
    const result = await md.fetch("test", { cwd: tmpDir });
    expect(result.title).toBe("List item as description");
  });

  it("falls back to filename when content is only whitespace", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "empty.md"), "   \n  \n   ", "utf-8");
    const result = await md.fetch("empty", { cwd: tmpDir });
    expect(result.title).toBe("empty");
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
    expect(result.number).toBe("1");
    const content = await readFile(join(specsDir, "1-my-new-feature.md"), "utf-8");
    expect(content).toBe("body content");
  });

  it("creates specs directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const result = await md.create("Auto Dir", "auto body", { cwd: tmpDir });
    expect(result.number).toBe("1");
    const content = await readFile(join(tmpDir, ".dispatch", "specs", "1-auto-dir.md"), "utf-8");
    expect(content).toBe("auto body");
  });

  it("returns correct IssueDetails for created file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const result = await md.create("Test Title", "body", { cwd: tmpDir });
    expect(result.title).toBe("body");
    expect(result.body).toBe("body");
    expect(result.state).toBe("open");
    expect(result.labels).toEqual([]);
  });
});

// ─── extractTitle — direct unit tests ────────────────────────────────

describe("extractTitle", () => {
  // --- H1 heading extraction (primary) ---

  it("extracts title from H1 heading", () => {
    expect(extractTitle("# My Title\n\nBody text", "file.md")).toBe("My Title");
  });

  it("extracts H1 heading even when not on first line", () => {
    expect(extractTitle("Some preamble\n# Actual Title\n\nBody", "file.md")).toBe("Actual Title");
  });

  it("trims whitespace from extracted H1 heading", () => {
    expect(extractTitle("#   Spaced Title  \n\nBody", "file.md")).toBe("Spaced Title");
  });

  it("uses first H1 when multiple H1 headings exist", () => {
    expect(extractTitle("# First\n\n# Second", "file.md")).toBe("First");
  });

  // --- Description-based extraction (secondary) ---

  it("extracts title from plain text description without H1", () => {
    expect(extractTitle("This is a plain text description", "my-spec.md")).toBe("This is a plain text description");
  });

  it("extracts title from first non-heading text line when only H2+ headings present", () => {
    expect(extractTitle("## Section Heading\n\nSome body text", "file.md")).toBe("Section Heading");
  });

  it("strips H2 prefix from content", () => {
    expect(extractTitle("## Subheading Title", "file.md")).toBe("Subheading Title");
  });

  it("strips H3 prefix from content", () => {
    expect(extractTitle("### Third Level Heading", "file.md")).toBe("Third Level Heading");
  });

  it("strips leading blockquote prefix from content", () => {
    expect(extractTitle("> This is a blockquote description", "file.md")).toBe("This is a blockquote description");
  });

  it("strips leading list marker dash from content", () => {
    expect(extractTitle("- First list item", "file.md")).toBe("First list item");
  });

  it("strips leading list marker asterisk from content", () => {
    expect(extractTitle("* Asterisk list item", "file.md")).toBe("Asterisk list item");
  });

  it("skips leading blank lines to find first meaningful content", () => {
    expect(extractTitle("\n\n\nActual content after blanks", "file.md")).toBe("Actual content after blanks");
  });

  it("skips lines that are only whitespace", () => {
    expect(extractTitle("   \n  \t  \nReal content here", "file.md")).toBe("Real content here");
  });

  it("handles content with leading blank lines before a non-H1 heading", () => {
    expect(extractTitle("\n\n## Delayed Heading\n\nBody", "file.md")).toBe("Delayed Heading");
  });

  // --- Truncation ---

  it("truncates content exceeding 80 characters at word boundary", () => {
    const longLine = "This is a very long description line that definitely exceeds the eighty character truncation limit and should be cut off at a word boundary";
    const result = extractTitle(longLine, "file.md");
    expect(result.length).toBeLessThanOrEqual(80);
    expect(longLine.startsWith(result)).toBe(true);
    // Should not end with a space
    expect(result).not.toMatch(/\s$/);
  });

  it("returns exactly 80 characters when the content breaks cleanly at 80", () => {
    // 80 chars exactly: "a" repeated pattern ending at exactly 80
    const exactly80 = "a".repeat(80);
    const result = extractTitle(exactly80, "file.md");
    expect(result).toBe(exactly80);
  });

  it("does not truncate content that is exactly 80 characters", () => {
    const content = "x".repeat(80);
    expect(extractTitle(content, "file.md")).toBe(content);
  });

  it("truncates a single long word without spaces to 80 characters", () => {
    const longWord = "a".repeat(100);
    const result = extractTitle(longWord, "file.md");
    expect(result.length).toBe(80);
    expect(result).toBe("a".repeat(80));
  });

  // --- Filename fallback (tertiary) ---

  it("falls back to filename when content is only whitespace", () => {
    expect(extractTitle("   \n  \n   ", "my-spec.md")).toBe("my-spec");
  });

  it("falls back to filename when content is empty string", () => {
    expect(extractTitle("", "fallback-name.md")).toBe("fallback-name");
  });

  it("falls back to filename when content has only markdown prefixes with no text", () => {
    expect(extractTitle("##\n>\n-\n*", "prefix-only.md")).toBe("prefix-only");
  });

  it("strips .md extension from filename in fallback", () => {
    expect(extractTitle("", "my-feature.md")).toBe("my-feature");
  });

  // --- Mixed formatting ---

  it("handles content with mixed formatting and extracts first meaningful line", () => {
    const content = "\n\n> Quoted intro to the feature\n\n## Details\n\n- item one\n- item two";
    expect(extractTitle(content, "file.md")).toBe("Quoted intro to the feature");
  });

  it("prefers H1 heading over plain text content", () => {
    expect(extractTitle("Plain text first\n# Heading After\nMore text", "file.md")).toBe("Heading After");
  });

  it("handles content with only a blockquote across multiple lines", () => {
    expect(extractTitle("> First quote line\n> Second quote line", "file.md")).toBe("First quote line");
  });

  it("handles content that starts with a markdown list", () => {
    const content = "- First item\n- Second item\n- Third item";
    expect(extractTitle(content, "file.md")).toBe("First item");
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
      expect(typeof ds.getUsername).toBe("function");
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

// ─── parseAzDevOpsRemoteUrl ──────────────────────────────────────────

describe("parseAzDevOpsRemoteUrl", () => {
  // --- HTTPS format (dev.azure.com) ---

  it("parses standard HTTPS dev.azure.com URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://dev.azure.com/myorg/myproject/_git/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "myproject",
    });
  });

  it("parses HTTPS dev.azure.com URL with user@ prefix", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://user@dev.azure.com/myorg/myproject/_git/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "myproject",
    });
  });

  it("parses HTTPS dev.azure.com URL case-insensitively", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://Dev.Azure.Com/MyOrg/MyProject/_git/MyRepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/MyOrg",
      project: "MyProject",
    });
  });

  // --- SSH format (ssh.dev.azure.com) ---

  it("parses SSH ssh.dev.azure.com URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "myproject",
    });
  });

  it("parses SSH URL case-insensitively", () => {
    const result = parseAzDevOpsRemoteUrl(
      "git@SSH.DEV.AZURE.COM:v3/MyOrg/MyProject/MyRepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/MyOrg",
      project: "MyProject",
    });
  });

  // --- Legacy format (visualstudio.com) ---

  it("parses legacy visualstudio.com URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://myorg.visualstudio.com/myproject/_git/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "myproject",
    });
  });

  it("parses legacy visualstudio.com URL with DefaultCollection", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "myproject",
    });
  });

  it("parses legacy visualstudio.com URL case-insensitively", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://MyOrg.VisualStudio.Com/MyProject/_git/MyRepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/MyOrg",
      project: "MyProject",
    });
  });

  // --- Normalized org URL ---

  it("normalizes SSH org URL to https://dev.azure.com format", () => {
    const result = parseAzDevOpsRemoteUrl(
      "git@ssh.dev.azure.com:v3/contoso/WebApp/WebApp"
    );
    expect(result?.orgUrl).toBe("https://dev.azure.com/contoso");
  });

  it("normalizes legacy org URL to https://dev.azure.com format", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://contoso.visualstudio.com/WebApp/_git/WebApp"
    );
    expect(result?.orgUrl).toBe("https://dev.azure.com/contoso");
  });

  // --- URL-encoded characters ---

  it("decodes URL-encoded characters in org name", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://dev.azure.com/my%20org/myproject/_git/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/my org",
      project: "myproject",
    });
  });

  it("decodes URL-encoded characters in project name", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://dev.azure.com/myorg/my%20project/_git/myrepo"
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "my project",
    });
  });

  // --- Non-Azure DevOps URLs (should return null) ---

  it("returns null for GitHub HTTPS URL", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://github.com/user/repo.git")
    ).toBeNull();
  });

  it("returns null for GitHub SSH URL", () => {
    expect(
      parseAzDevOpsRemoteUrl("git@github.com:user/repo.git")
    ).toBeNull();
  });

  it("returns null for GitLab URL", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://gitlab.com/user/repo.git")
    ).toBeNull();
  });

  it("returns null for Bitbucket URL", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://bitbucket.org/user/repo.git")
    ).toBeNull();
  });

  // --- Malformed and edge cases ---

  it("returns null for empty string", () => {
    expect(parseAzDevOpsRemoteUrl("")).toBeNull();
  });

  it("returns null for malformed dev.azure.com URL missing _git segment", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://dev.azure.com/myorg/myproject/myrepo")
    ).toBeNull();
  });

  it("returns null for malformed SSH URL missing v3 prefix", () => {
    expect(
      parseAzDevOpsRemoteUrl("git@ssh.dev.azure.com:myorg/myproject/myrepo")
    ).toBeNull();
  });

  it("returns null for plain text that is not a URL", () => {
    expect(parseAzDevOpsRemoteUrl("not a url at all")).toBeNull();
  });

  it("returns null for dev.azure.com URL with only org (no project)", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://dev.azure.com/myorg")
    ).toBeNull();
  });
});
