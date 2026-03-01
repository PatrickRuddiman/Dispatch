import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Datasource, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";

vi.mock("../logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    task: vi.fn(),
    verbose: false,
    formatErrorChain: vi.fn().mockReturnValue(""),
  },
}));

// Must import log AFTER vi.mock to get the mocked version
import { log } from "../logger.js";
import {
  parseIssueFilename,
  fetchItemsById,
  writeItemsToTempDir,
} from "../orchestrator/datasource-helpers.js";

/** Create a mock Datasource with all methods stubbed via vi.fn(). */
function createMockDatasource(overrides?: Partial<Datasource>): Datasource {
  return {
    name: "github",
    list: vi.fn<Datasource["list"]>().mockResolvedValue([]),
    fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue({} as IssueDetails),
    update: vi.fn<Datasource["update"]>().mockResolvedValue(undefined),
    close: vi.fn<Datasource["close"]>().mockResolvedValue(undefined),
    create: vi.fn<Datasource["create"]>().mockResolvedValue({} as IssueDetails),
    getDefaultBranch: vi.fn<Datasource["getDefaultBranch"]>().mockResolvedValue("main"),
    buildBranchName: vi.fn<Datasource["buildBranchName"]>().mockReturnValue("dispatch/1-test"),
    createAndSwitchBranch: vi.fn<Datasource["createAndSwitchBranch"]>().mockResolvedValue(undefined),
    switchBranch: vi.fn<Datasource["switchBranch"]>().mockResolvedValue(undefined),
    pushBranch: vi.fn<Datasource["pushBranch"]>().mockResolvedValue(undefined),
    createPullRequest: vi.fn<Datasource["createPullRequest"]>().mockResolvedValue("https://github.com/org/repo/pull/1"),
    ...overrides,
  };
}

/** Create an IssueDetails fixture with sensible defaults. */
function createIssueDetails(overrides?: Partial<IssueDetails>): IssueDetails {
  return {
    number: "1",
    title: "Default Title",
    body: "Default body content",
    labels: [],
    state: "open",
    url: "https://github.com/org/repo/issues/1",
    comments: [],
    acceptanceCriteria: "",
    ...overrides,
  };
}

// ─── parseIssueFilename ──────────────────────────────────────────────

describe("parseIssueFilename", () => {
  it("parses a standard issue filename", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc123/42-add-user-auth.md");
    expect(result).toEqual({ issueId: "42", slug: "add-user-auth" });
  });

  it("parses a filename with a long numeric ID", () => {
    const result = parseIssueFilename("/some/path/12345-fix-bug.md");
    expect(result).toEqual({ issueId: "12345", slug: "fix-bug" });
  });

  it("parses a filename with a single-digit ID", () => {
    const result = parseIssueFilename("/tmp/1-a.md");
    expect(result).toEqual({ issueId: "1", slug: "a" });
  });

  it("handles a bare filename without directory path", () => {
    const result = parseIssueFilename("7-my-feature.md");
    expect(result).toEqual({ issueId: "7", slug: "my-feature" });
  });

  it("returns null for a filename without a numeric prefix", () => {
    const result = parseIssueFilename("/tmp/my-feature.md");
    expect(result).toBeNull();
  });

  it("returns null for a filename with no slug after the ID", () => {
    const result = parseIssueFilename("/tmp/42.md");
    expect(result).toBeNull();
  });

  it("returns null for a non-.md file", () => {
    const result = parseIssueFilename("/tmp/42-feature.txt");
    expect(result).toBeNull();
  });

  it("returns null for an empty string", () => {
    const result = parseIssueFilename("");
    expect(result).toBeNull();
  });

  it("preserves hyphens in multi-word slugs", () => {
    const result = parseIssueFilename("99-sync-task-completion-state-back-to-datasource.md");
    expect(result).toEqual({ issueId: "99", slug: "sync-task-completion-state-back-to-datasource" });
  });

  it("extracts both issueId and slug as separate components", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc/123-some-slug.md");
    expect(result).not.toBeNull();
    expect(result!.issueId).toBe("123");
    expect(result!.slug).toBe("some-slug");
  });

  it("returns null for a filename with no extension", () => {
    const result = parseIssueFilename("/tmp/42-feature");
    expect(result).toBeNull();
  });

  it("returns null for a filename with a .json extension", () => {
    const result = parseIssueFilename("10-config.json");
    expect(result).toBeNull();
  });

  it("returns null for a filename with a .markdown extension", () => {
    const result = parseIssueFilename("/tmp/10-notes.markdown");
    expect(result).toBeNull();
  });

  it("returns null when filename starts with a dash", () => {
    const result = parseIssueFilename("-no-id.md");
    expect(result).toBeNull();
  });

  it("returns null for a filename that is just a number with .md", () => {
    const result = parseIssueFilename("123.md");
    expect(result).toBeNull();
  });

  it("handles slug containing dots", () => {
    const result = parseIssueFilename("42-fix-v1.2-bug.md");
    expect(result).toEqual({ issueId: "42", slug: "fix-v1.2-bug" });
  });

  it("handles leading zeros in the issue ID", () => {
    const result = parseIssueFilename("007-bond-feature.md");
    expect(result).toEqual({ issueId: "007", slug: "bond-feature" });
  });

  it("handles a very long numeric ID", () => {
    const result = parseIssueFilename("9999999-edge.md");
    expect(result).toEqual({ issueId: "9999999", slug: "edge" });
  });

  it("returns null for a directory-only path with no filename match", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc123/");
    expect(result).toBeNull();
  });

  it("handles slug that is a single character", () => {
    const result = parseIssueFilename("5-x.md");
    expect(result).toEqual({ issueId: "5", slug: "x" });
  });

  it("returns null when there is no dash separator", () => {
    const result = parseIssueFilename("42feature.md");
    expect(result).toBeNull();
  });
});

// ─── fetchItemsById ─────────────────────────────────────────────────

describe("fetchItemsById", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a single issue by ID", async () => {
    const issue = createIssueDetails({ number: "42", title: "Fix bug" });
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue(issue),
    });
    const fetchOpts: IssueFetchOptions = { cwd: "/tmp" };

    const result = await fetchItemsById(["42"], ds, fetchOpts);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(issue);
    expect(ds.fetch).toHaveBeenCalledOnce();
    expect(ds.fetch).toHaveBeenCalledWith("42", fetchOpts);
  });

  it("fetches multiple issues by ID", async () => {
    const issue1 = createIssueDetails({ number: "1", title: "First" });
    const issue2 = createIssueDetails({ number: "2", title: "Second" });
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>()
        .mockResolvedValueOnce(issue1)
        .mockResolvedValueOnce(issue2),
    });

    const result = await fetchItemsById(["1", "2"], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(issue1);
    expect(result[1]).toEqual(issue2);
    expect(ds.fetch).toHaveBeenCalledTimes(2);
  });

  it("splits comma-separated IDs into individual fetches", async () => {
    const issue1 = createIssueDetails({ number: "10", title: "Ten" });
    const issue2 = createIssueDetails({ number: "20", title: "Twenty" });
    const issue3 = createIssueDetails({ number: "30", title: "Thirty" });
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>()
        .mockResolvedValueOnce(issue1)
        .mockResolvedValueOnce(issue2)
        .mockResolvedValueOnce(issue3),
    });

    const result = await fetchItemsById(["10,20,30"], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(3);
    expect(ds.fetch).toHaveBeenCalledTimes(3);
    expect(ds.fetch).toHaveBeenCalledWith("10", { cwd: "/tmp" });
    expect(ds.fetch).toHaveBeenCalledWith("20", { cwd: "/tmp" });
    expect(ds.fetch).toHaveBeenCalledWith("30", { cwd: "/tmp" });
  });

  it("trims whitespace from comma-separated IDs", async () => {
    const issue = createIssueDetails({ number: "5", title: "Trimmed" });
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue(issue),
    });

    const result = await fetchItemsById(["  5 , 6 "], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(ds.fetch).toHaveBeenCalledWith("5", { cwd: "/tmp" });
    expect(ds.fetch).toHaveBeenCalledWith("6", { cwd: "/tmp" });
  });

  it("filters out empty strings from comma-separated IDs", async () => {
    const issue = createIssueDetails({ number: "7", title: "Seven" });
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue(issue),
    });

    const result = await fetchItemsById(["7,,"], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(1);
    expect(ds.fetch).toHaveBeenCalledOnce();
    expect(ds.fetch).toHaveBeenCalledWith("7", { cwd: "/tmp" });
  });

  it("skips failed fetches and logs a warning", async () => {
    const issue1 = createIssueDetails({ number: "1", title: "OK" });
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>()
        .mockResolvedValueOnce(issue1)
        .mockRejectedValueOnce(new Error("Not found"))
        .mockResolvedValueOnce(createIssueDetails({ number: "3", title: "Also OK" })),
    });

    const result = await fetchItemsById(["1", "2", "3"], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(result[0].number).toBe("1");
    expect(result[1].number).toBe("3");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("#2"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Not found"));
  });

  it("handles non-Error rejection and logs a warning", async () => {
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>().mockRejectedValue("network timeout"),
    });

    const result = await fetchItemsById(["99"], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("network timeout"));
  });

  it("returns an empty array when all fetches fail", async () => {
    const ds = createMockDatasource({
      fetch: vi.fn<Datasource["fetch"]>().mockRejectedValue(new Error("fail")),
    });

    const result = await fetchItemsById(["1", "2"], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(0);
    expect(ds.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array for an empty input array", async () => {
    const ds = createMockDatasource();

    const result = await fetchItemsById([], ds, { cwd: "/tmp" });

    expect(result).toHaveLength(0);
    expect(ds.fetch).not.toHaveBeenCalled();
  });
});

// ─── writeItemsToTempDir ────────────────────────────────────────────

describe("writeItemsToTempDir", () => {
  let tempFiles: string[] = [];

  afterEach(async () => {
    // Clean up any temp directories created by writeItemsToTempDir
    for (const file of tempFiles) {
      const dir = join(file, "..");
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempFiles = [];
  });

  it("writes a single issue to a temp file with correct filename", async () => {
    const item = createIssueDetails({
      number: "42",
      title: "Add User Auth",
      body: "# Add User Auth\n\n- [ ] Implement login",
    });

    const result = await writeItemsToTempDir([item]);
    tempFiles = result.files;

    expect(result.files).toHaveLength(1);
    expect(basename(result.files[0])).toBe("42-add-user-auth.md");

    const content = await readFile(result.files[0], "utf-8");
    expect(content).toBe("# Add User Auth\n\n- [ ] Implement login");
  });

  it("creates slugs by lowercasing and replacing non-alphanumeric chars with hyphens", async () => {
    const item = createIssueDetails({
      number: "10",
      title: "Fix Bug #123 (Urgent!)",
      body: "body",
    });

    const result = await writeItemsToTempDir([item]);
    tempFiles = result.files;

    // "Fix Bug #123 (Urgent!)" -> "fix-bug-123-urgent"
    expect(basename(result.files[0])).toBe("10-fix-bug-123-urgent.md");
  });

  it("trims leading and trailing hyphens from slug", async () => {
    const item = createIssueDetails({
      number: "5",
      title: "---Special---",
      body: "body",
    });

    const result = await writeItemsToTempDir([item]);
    tempFiles = result.files;

    // "---Special---" -> "special" (leading/trailing hyphens stripped)
    expect(basename(result.files[0])).toBe("5-special.md");
  });

  it("truncates slug to 60 characters", async () => {
    const longTitle = "a".repeat(100);
    const item = createIssueDetails({
      number: "1",
      title: longTitle,
      body: "body",
    });

    const result = await writeItemsToTempDir([item]);
    tempFiles = result.files;

    const filename = basename(result.files[0]);
    // "1-" + 60 chars + ".md"
    expect(filename).toBe(`1-${"a".repeat(60)}.md`);
  });

  it("sorts output files by numeric prefix", async () => {
    const items = [
      createIssueDetails({ number: "30", title: "Third", body: "c" }),
      createIssueDetails({ number: "10", title: "First", body: "a" }),
      createIssueDetails({ number: "20", title: "Second", body: "b" }),
    ];

    const result = await writeItemsToTempDir(items);
    tempFiles = result.files;

    expect(result.files).toHaveLength(3);
    expect(basename(result.files[0])).toBe("10-first.md");
    expect(basename(result.files[1])).toBe("20-second.md");
    expect(basename(result.files[2])).toBe("30-third.md");
  });

  it("returns a mapping from file path to IssueDetails", async () => {
    const item = createIssueDetails({
      number: "7",
      title: "Map Test",
      body: "mapped body",
    });

    const result = await writeItemsToTempDir([item]);
    tempFiles = result.files;

    expect(result.issueDetailsByFile.size).toBe(1);
    const mapped = result.issueDetailsByFile.get(result.files[0]);
    expect(mapped).toBeDefined();
    expect(mapped!.number).toBe("7");
    expect(mapped!.title).toBe("Map Test");
    expect(mapped!.body).toBe("mapped body");
  });

  it("handles an empty items array", async () => {
    const result = await writeItemsToTempDir([]);
    // Should still create the temp dir but with no files
    expect(result.files).toHaveLength(0);
    expect(result.issueDetailsByFile.size).toBe(0);
  });

  it("writes multiple items and maps each correctly", async () => {
    const items = [
      createIssueDetails({ number: "1", title: "Alpha", body: "body-a" }),
      createIssueDetails({ number: "2", title: "Beta", body: "body-b" }),
    ];

    const result = await writeItemsToTempDir(items);
    tempFiles = result.files;

    expect(result.files).toHaveLength(2);
    expect(result.issueDetailsByFile.size).toBe(2);

    for (const file of result.files) {
      const mapped = result.issueDetailsByFile.get(file);
      expect(mapped).toBeDefined();
      const content = await readFile(file, "utf-8");
      expect(content).toBe(mapped!.body);
    }
  });
});
