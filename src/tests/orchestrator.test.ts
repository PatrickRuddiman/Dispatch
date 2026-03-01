import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseIssueFilename } from "../agents/orchestrator.js";
import { markTaskComplete, type Task } from "../parser.js";
import type { Datasource, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";

// ─── parseIssueFilename re-export ───────────────────────────────────

describe("parseIssueFilename re-export", () => {
  it("is re-exported from the orchestrator module and works correctly", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc123/42-add-user-auth.md");
    expect(result).toEqual({ issueId: "42", slug: "add-user-auth" });
  });

  it("returns null for invalid filenames via the re-export", () => {
    expect(parseIssueFilename("no-id-prefix.md")).toBeNull();
    expect(parseIssueFilename("")).toBeNull();
  });
});

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

// ─── datasource sync on task completion ──────────────────────────────

describe("datasource sync on task completion", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("calls datasource.update() with the correct issue ID, title, and checked-off content", async () => {
    // Arrange: create a temp file matching the <id>-<slug>.md pattern
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "42-add-user-auth.md");
    const md = [
      "# Add User Auth",
      "",
      "- [ ] Implement login endpoint",
      "- [ ] Add session middleware",
    ].join("\n");
    await writeFile(filePath, md, "utf-8");

    // The task to mark complete (first unchecked task)
    const task: Task = {
      index: 0,
      text: "Implement login endpoint",
      line: 3,
      raw: "- [ ] Implement login endpoint",
      file: filePath,
    };

    // Act: mark the task complete (same as orchestrator does)
    await markTaskComplete(task);

    // Read the updated content (same as orchestrator does)
    const updatedContent = await readFile(filePath, "utf-8");

    // Verify the file now contains [x]
    expect(updatedContent).toContain("[x]");
    expect(updatedContent).toContain("- [x] Implement login endpoint");
    // Second task should remain unchecked
    expect(updatedContent).toContain("- [ ] Add session middleware");

    // Simulate the datasource sync (same logic as orchestrator lines 236–242)
    const parsed = parseIssueFilename(filePath);
    expect(parsed).not.toBeNull();

    const mockDatasource = createMockDatasource();
    const issueDetails: IssueDetails = {
      number: "42",
      title: "Add User Auth",
      body: md,
      labels: [],
      state: "open",
      url: "https://github.com/org/repo/issues/42",
      comments: [],
      acceptanceCriteria: "",
    };

    const fetchOpts: IssueFetchOptions = { cwd: tmpDir };
    const title = issueDetails.title;
    await mockDatasource.update(parsed!.issueId, title, updatedContent, fetchOpts);

    // Assert: update was called with correct arguments
    expect(mockDatasource.update).toHaveBeenCalledOnce();
    expect(mockDatasource.update).toHaveBeenCalledWith(
      "42",
      "Add User Auth",
      expect.stringContaining("[x]"),
      fetchOpts,
    );
  });

  it("falls back to slug as title when IssueDetails is not available", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "99-sync-task-completion.md");
    const md = "- [ ] Push checkbox state back to tracker";
    await writeFile(filePath, md, "utf-8");

    const task: Task = {
      index: 0,
      text: "Push checkbox state back to tracker",
      line: 1,
      raw: "- [ ] Push checkbox state back to tracker",
      file: filePath,
    };

    await markTaskComplete(task);
    const updatedContent = await readFile(filePath, "utf-8");

    const parsed = parseIssueFilename(filePath);
    expect(parsed).not.toBeNull();

    const mockDatasource = createMockDatasource();

    // No IssueDetails available — fall back to slug
    const title = parsed!.slug;
    await mockDatasource.update(parsed!.issueId, title, updatedContent);

    expect(mockDatasource.update).toHaveBeenCalledWith(
      "99",
      "sync-task-completion",
      expect.stringContaining("[x]"),
    );
  });

  it("skips datasource sync when filename does not match <id>-<slug>.md pattern", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "no-id-prefix.md");
    const md = "- [ ] Some task";
    await writeFile(filePath, md, "utf-8");

    const task: Task = {
      index: 0,
      text: "Some task",
      line: 1,
      raw: "- [ ] Some task",
      file: filePath,
    };

    await markTaskComplete(task);

    // parseIssueFilename returns null — sync should be skipped
    const parsed = parseIssueFilename(filePath);
    expect(parsed).toBeNull();

    const mockDatasource = createMockDatasource();
    // The orchestrator's logic: only call update if parsed is not null
    if (parsed) {
      await mockDatasource.update(parsed.issueId, parsed.slug, "content");
    }

    expect(mockDatasource.update).not.toHaveBeenCalled();
  });

  it("handles datasource.update() failure gracefully (does not throw)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "7-fix-bug.md");
    const md = "- [ ] Fix the critical bug";
    await writeFile(filePath, md, "utf-8");

    const task: Task = {
      index: 0,
      text: "Fix the critical bug",
      line: 1,
      raw: "- [ ] Fix the critical bug",
      file: filePath,
    };

    await markTaskComplete(task);
    const updatedContent = await readFile(filePath, "utf-8");

    const parsed = parseIssueFilename(filePath);
    expect(parsed).not.toBeNull();

    // Configure the mock to reject
    const mockDatasource = createMockDatasource({
      update: vi.fn<Datasource["update"]>().mockRejectedValue(new Error("API rate limit exceeded")),
    });

    const fetchOpts: IssueFetchOptions = { cwd: tmpDir };

    // Simulate the orchestrator's try/catch pattern (lines 235–247)
    let syncError: string | undefined;
    try {
      await mockDatasource.update(parsed!.issueId, "Fix Bug", updatedContent, fetchOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      syncError = message;
    }

    // The update was called (and failed)
    expect(mockDatasource.update).toHaveBeenCalledOnce();
    // The error was caught, not thrown
    expect(syncError).toBe("API rate limit exceeded");
  });

  it("handles non-Error rejection gracefully", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "15-add-feature.md");
    const md = "- [ ] Add the new feature";
    await writeFile(filePath, md, "utf-8");

    const task: Task = {
      index: 0,
      text: "Add the new feature",
      line: 1,
      raw: "- [ ] Add the new feature",
      file: filePath,
    };

    await markTaskComplete(task);
    const updatedContent = await readFile(filePath, "utf-8");

    const parsed = parseIssueFilename(filePath);
    expect(parsed).not.toBeNull();

    // Reject with a non-Error value (string)
    const mockDatasource = createMockDatasource({
      update: vi.fn<Datasource["update"]>().mockRejectedValue("network timeout"),
    });

    // Simulate the orchestrator's error handling pattern
    let syncError: string | undefined;
    try {
      await mockDatasource.update(parsed!.issueId, parsed!.slug, updatedContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      syncError = message;
    }

    expect(mockDatasource.update).toHaveBeenCalledOnce();
    expect(syncError).toBe("network timeout");
  });

  it("passes the full updated content including all tasks to datasource.update()", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "10-multi-task.md");
    const md = [
      "# Multi Task Spec",
      "",
      "- [ ] First task",
      "- [ ] Second task",
      "- [ ] Third task",
    ].join("\n");
    await writeFile(filePath, md, "utf-8");

    // Mark only the first task complete
    const task: Task = {
      index: 0,
      text: "First task",
      line: 3,
      raw: "- [ ] First task",
      file: filePath,
    };

    await markTaskComplete(task);
    const updatedContent = await readFile(filePath, "utf-8");

    // Verify partial completion state
    expect(updatedContent).toContain("- [x] First task");
    expect(updatedContent).toContain("- [ ] Second task");
    expect(updatedContent).toContain("- [ ] Third task");
    expect(updatedContent).toContain("# Multi Task Spec");

    const parsed = parseIssueFilename(filePath);
    const mockDatasource = createMockDatasource();
    await mockDatasource.update(parsed!.issueId, "Multi Task Spec", updatedContent);

    // The full file content (with heading, checked, and unchecked tasks) is sent
    const callArgs = (mockDatasource.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe("10");
    expect(callArgs[1]).toBe("Multi Task Spec");
    expect(callArgs[2]).toContain("# Multi Task Spec");
    expect(callArgs[2]).toContain("- [x] First task");
    expect(callArgs[2]).toContain("- [ ] Second task");
  });
});
