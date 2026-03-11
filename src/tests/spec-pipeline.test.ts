import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

// ─── Hoisted mock references ────────────────────────────────────────

const { mocks } = vi.hoisted(() => {
  return {
    mocks: {
      mockGenerate: vi.fn(),
      mockAgentCleanup: vi.fn().mockResolvedValue(undefined),
      mockProviderCleanup: vi.fn().mockResolvedValue(undefined),
      mockCreateSession: vi.fn().mockResolvedValue("sess-1"),
      mockPrompt: vi.fn().mockResolvedValue("done"),
      mockFetch: vi.fn(),
      mockUpdate: vi.fn(),
      mockCreate: vi.fn(),
      mockGlob: vi.fn(),
    },
  };
});

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("../helpers/logger.js", () => ({
  log: {
    verbose: false,
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    task: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
    formatErrorChain: vi.fn((e: unknown) => String(e)),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../helpers/format.js", () => ({
  elapsed: vi.fn().mockReturnValue("0s"),
  renderHeaderLines: vi.fn().mockReturnValue(["mock-header"]),
}));

vi.mock("../helpers/slugify.js", () => ({
  MAX_SLUG_LENGTH: 60,
  slugify: vi.fn((input: string, maxLen?: number) => {
    const slug = input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return maxLen != null ? slug.slice(0, maxLen) : slug;
  }),
}));

vi.mock("../spec-generator.js", () => ({
  DEFAULT_SPEC_TIMEOUT_MIN: 10,
  isIssueNumbers: vi.fn(),
  isGlobOrFilePath: vi.fn(),
  resolveSource: vi.fn(),
  defaultConcurrency: vi.fn().mockReturnValue(2),
}));

vi.mock("../datasources/index.js", () => ({
  getDatasource: vi.fn().mockReturnValue({
    name: "github",
    fetch: mocks.mockFetch,
    update: mocks.mockUpdate,
    create: mocks.mockCreate,
  }),
}));

vi.mock("../datasources/md.js", () => ({
  extractTitle: vi.fn().mockReturnValue("Mock Title"),
}));

vi.mock("../providers/index.js", () => ({
  bootProvider: vi.fn().mockResolvedValue({
    name: "mock",
    model: "mock-model",
    createSession: mocks.mockCreateSession,
    prompt: mocks.mockPrompt,
    cleanup: mocks.mockProviderCleanup,
  }),
}));

vi.mock("../agents/spec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/spec.js")>();
  return {
    ...actual,
    boot: vi.fn().mockResolvedValue({
      name: "spec",
      generate: mocks.mockGenerate,
      cleanup: mocks.mockAgentCleanup,
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("# Mock Content\n\nBody text"),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("glob", () => ({
  glob: mocks.mockGlob,
}));

vi.mock("../helpers/confirm-large-batch.js", () => ({
  LARGE_BATCH_THRESHOLD: 100,
  confirmLargeBatch: vi.fn().mockResolvedValue(true),
}));

// ─── Import function under test (after mocks) ──────────────────────

import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";
import { buildSpecPrompt } from "../agents/spec.js";
import { log } from "../helpers/logger.js";
import { isIssueNumbers, isGlobOrFilePath, resolveSource } from "../spec-generator.js";
import { getDatasource } from "../datasources/index.js";
import { readFile, mkdir, rename, unlink } from "node:fs/promises";
import { extractTitle } from "../datasources/md.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import { bootProvider } from "../providers/index.js";
import type { SpecOptions } from "../spec-generator.js";
import { createMockDatasource } from "./fixtures.js";

// ─── Helpers ────────────────────────────────────────────────────────

function baseOpts(overrides?: Partial<SpecOptions>): SpecOptions {
  return {
    issues: "1,2",
    provider: "opencode" as const,
    cwd: "/tmp/test-cwd",
    outputDir: "/tmp/test-cwd/.dispatch/specs",
    concurrency: 1,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("runSpecPipeline", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Default: datasource returns github
    vi.mocked(getDatasource).mockReturnValue(
      createMockDatasource("github", {
        fetch: mocks.mockFetch,
        update: mocks.mockUpdate,
        create: mocks.mockCreate,
      }),
    );

    // Default: tracker mode
    vi.mocked(isIssueNumbers).mockReturnValue(true);
    vi.mocked(isGlobOrFilePath).mockReturnValue(false);
    vi.mocked(resolveSource).mockResolvedValue("github");

    // Default: fetch returns valid issue details
    mocks.mockFetch.mockResolvedValue({
      number: "1",
      title: "Test Issue",
      body: "Issue body",
      labels: [],
      state: "open",
      url: "https://example.com/1",
      comments: [],
      acceptanceCriteria: "",
    });

    // Default: spec generation succeeds
    mocks.mockGenerate.mockResolvedValue({
      data: {
        content: "# Generated Spec\n\n## Tasks\n\n- [ ] Do something",
        valid: true,
      },
      success: true,
    });

    // Default: datasource operations succeed
    mocks.mockUpdate.mockResolvedValue(undefined);
    mocks.mockCreate.mockResolvedValue({ number: "99", title: "Created Issue" });
    mocks.mockProviderCleanup.mockResolvedValue(undefined);
    mocks.mockAgentCleanup.mockResolvedValue(undefined);

    // Default: large batch confirmation auto-accepts
    vi.mocked(confirmLargeBatch).mockResolvedValue(true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // ── Source resolution ───────────────────────────────────────────

  describe("source resolution", () => {
    it("returns early with zero counts when resolveSource returns null", async () => {
      vi.mocked(resolveSource).mockResolvedValue(null);

      const result = await runSpecPipeline(baseOpts());

      expect(result.total).toBe(0);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.files).toEqual([]);
      expect(result.issueNumbers).toEqual([]);
    });
  });

  // ── Tracker mode ────────────────────────────────────────────────

  describe("tracker mode", () => {
    it("fetches issues and generates specs successfully", async () => {
      const result = await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 1 }));

      expect(mocks.mockFetch).toHaveBeenCalledTimes(2);
      expect(mocks.mockGenerate).toHaveBeenCalledTimes(2);
      expect(mocks.mockUpdate).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
      expect(result.generated).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("returns early when no issue numbers are parsed", async () => {
      const result = await runSpecPipeline(baseOpts({ issues: "" }));

      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("No issue numbers provided"),
      );
      expect(result.total).toBe(0);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("handles fetch errors gracefully and marks as failed", async () => {
      mocks.mockFetch
        .mockRejectedValueOnce(new Error("Not found"))
        .mockResolvedValueOnce({
          number: "2",
          title: "Test Issue 2",
          body: "Issue body 2",
          labels: [],
          state: "open",
          url: "https://example.com/2",
          comments: [],
          acceptanceCriteria: "",
        });

      const result = await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 1 }));

      expect(result.total).toBe(2);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(1);
    });

    it("returns failed count when all fetches fail", async () => {
      mocks.mockFetch.mockRejectedValue(new Error("Not found"));

      const result = await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 1 }));

      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("No issues could be loaded"),
      );
      expect(result.total).toBe(2);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(2);
    });

    it("handles spec generation failure", async () => {
      mocks.mockGenerate.mockResolvedValue({
        data: null,
        success: false,
        error: "Generation failed",
      });

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(result.total).toBe(1);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("handles datasource update failure gracefully", async () => {
      mocks.mockUpdate.mockRejectedValue(new Error("Sync failed"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Could not sync"),
      );
      expect(result.generated).toBe(1);
    });

    it("keeps multi-item tracker generation scoped per item and preserves batch semantics", async () => {
      const prompts = new Map<string, string>();

      mocks.mockFetch
        .mockResolvedValueOnce({
          number: "1",
          title: "Test Issue 1",
          body: "Issue body 1",
          labels: [],
          state: "open",
          url: "https://example.com/1",
          comments: [],
          acceptanceCriteria: "",
        })
        .mockResolvedValueOnce({
          number: "2",
          title: "Test Issue 2",
          body: "Issue body 2",
          labels: [],
          state: "open",
          url: "https://example.com/2",
          comments: [],
          acceptanceCriteria: "",
        });

      mocks.mockGenerate.mockImplementation(async ({ issue, cwd, outputPath }) => {
        prompts.set(issue.number, buildSpecPrompt(issue, cwd, outputPath));

        return {
          data: {
            content: "# Generated Spec\n\n## Tasks\n\n- [ ] Do something",
            valid: true,
          },
          success: true,
        };
      });

      const result = await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 2 }));

      expect(result.total).toBe(2);
      expect(result.generated).toBe(2);
      expect(result.failed).toBe(0);
      expect(mocks.mockGenerate).toHaveBeenCalledTimes(2);
      expect(mocks.mockUpdate).toHaveBeenCalledTimes(2);

      const generateCalls = mocks.mockGenerate.mock.calls;
      const issueNumbers = generateCalls
        .map(([opts]) => opts.issue?.number)
        .filter((issueNumber): issueNumber is string => issueNumber != null)
        .sort();
      const outputPaths = generateCalls
        .map(([opts]) => opts.outputPath)
        .sort();

      expect(issueNumbers).toEqual(["1", "2"]);
      expect(outputPaths).toEqual([
        expect.stringContaining("1-test-issue-1.md"),
        expect.stringContaining("2-test-issue-2.md"),
      ]);

      const prompt1 = prompts.get("1");
      const prompt2 = prompts.get("2");

      expect(prompt1).toBeDefined();
      expect(prompt2).toBeDefined();

      for (const prompt of [prompt1, prompt2]) {
        expect(prompt).toContain("scoped to exactly one source item");
        expect(prompt).toContain("single passed issue, file, or inline request");
        expect(prompt).toContain("context only unless the passed source explicitly references them");
        expect(prompt).toContain("Do not merge unrelated specs, issues, files, or requests into the generated output");
      }

      expect(prompt1).toContain("#1");
      expect(prompt1).toContain("Test Issue 1");
      expect(prompt1).toContain("Issue body 1");
      expect(prompt1).not.toContain("Test Issue 2");
      expect(prompt1).not.toContain("Issue body 2");

      expect(prompt2).toContain("#2");
      expect(prompt2).toContain("Test Issue 2");
      expect(prompt2).toContain("Issue body 2");
      expect(prompt2).not.toContain("Test Issue 1");
      expect(prompt2).not.toContain("Issue body 1");
    });
  });

  // ── Inline text mode ────────────────────────────────────────────

  describe("inline text mode", () => {
    it("generates a spec from inline text", async () => {
      vi.mocked(isIssueNumbers).mockReturnValue(false);
      vi.mocked(isGlobOrFilePath).mockReturnValue(false);

      const result = await runSpecPipeline(baseOpts({ issues: "Build a login page" }));

      expect(mocks.mockGenerate).toHaveBeenCalledOnce();
      expect(mocks.mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expect.any(String) }),
      );
      expect(result.total).toBe(1);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  // ── File/glob mode ──────────────────────────────────────────────

  describe("file/glob mode", () => {
    beforeEach(() => {
      vi.mocked(isIssueNumbers).mockReturnValue(false);
      vi.mocked(isGlobOrFilePath).mockReturnValue(true);
    });

    it("resolves files from a glob and generates specs", async () => {
      mocks.mockGlob.mockResolvedValue([
        "/tmp/test-cwd/spec1.md",
        "/tmp/test-cwd/spec2.md",
      ]);
      vi.mocked(readFile).mockResolvedValue("# File Content\n\nBody");

      const result = await runSpecPipeline(baseOpts({ issues: "*.md" }));

      expect(result.total).toBe(2);
      expect(result.generated).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("returns early when glob matches no files", async () => {
      mocks.mockGlob.mockResolvedValue([]);

      const result = await runSpecPipeline(baseOpts({ issues: "*.md" }));

      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("No files matched"),
      );
      expect(result.total).toBe(0);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("handles file read errors in glob mode", async () => {
      mocks.mockGlob.mockResolvedValue(["/tmp/test-cwd/spec1.md"]);
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const result = await runSpecPipeline(baseOpts({ issues: "*.md" }));

      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("No files could be loaded"),
      );
      expect(result.total).toBe(1);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("creates new issue and deletes local file when datasource is not md", async () => {
      mocks.mockGlob.mockResolvedValue(["/tmp/test-cwd/spec1.md"]);
      vi.mocked(readFile).mockResolvedValue("# File Content\n\nBody");

      const result = await runSpecPipeline(baseOpts({ issues: "*.md" }));

      expect(mocks.mockCreate).toHaveBeenCalled();
      expect(unlink).toHaveBeenCalled();
      expect(result.issueNumbers).toContain("99");
    });

    it("creates numbered spec and deletes original when datasource is md and file has no ID prefix", async () => {
      vi.mocked(getDatasource).mockReturnValue(
        createMockDatasource("md", {
          fetch: mocks.mockFetch,
          update: mocks.mockUpdate,
          create: mocks.mockCreate,
        }),
      );
      mocks.mockGlob.mockResolvedValue(["/tmp/test-cwd/spec1.md"]);
      vi.mocked(readFile).mockResolvedValue("# File Content\n\nBody");

      const result = await runSpecPipeline(baseOpts({ issues: "*.md" }));

      expect(mocks.mockCreate).toHaveBeenCalledWith(
        "Mock Title",
        expect.any(String),
        expect.any(Object),
      );
      expect(unlink).toHaveBeenCalledWith("/tmp/test-cwd/spec1.md");
      expect(result.issueNumbers).toContain("99");
      expect(result.generated).toBe(1);
    });

    it("updates spec in-place when datasource is md and file has ID prefix (respec)", async () => {
      vi.mocked(getDatasource).mockReturnValue(
        createMockDatasource("md", {
          fetch: mocks.mockFetch,
          update: mocks.mockUpdate,
          create: mocks.mockCreate,
        }),
      );
      mocks.mockGlob.mockResolvedValue(["/tmp/test-cwd/.dispatch/specs/3-my-feature.md"]);
      vi.mocked(readFile).mockResolvedValue("# My Feature\n\nBody");

      const result = await runSpecPipeline(baseOpts({ issues: ".dispatch/specs/3-*.md" }));

      expect(mocks.mockUpdate).toHaveBeenCalledWith(
        "3",
        "Mock Title",
        expect.any(String),
        expect.any(Object),
      );
      expect(mocks.mockCreate).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(result.issueNumbers).toContain("3");
      expect(result.generated).toBe(1);
    });
  });

  // ── Datasource sync ─────────────────────────────────────────────

  describe("datasource sync", () => {
    it("updates existing issue in tracker mode", async () => {
      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(mocks.mockUpdate).toHaveBeenCalledWith(
        "1",
        "Test Issue",
        expect.any(String),
        expect.any(Object),
      );
      expect(result.issueNumbers).toContain("1");
      expect(unlink).toHaveBeenCalledWith(join("/tmp/test-cwd/.dispatch/specs", "1-mock-title.md"));
    });

    it("logs success message after deleting local spec in tracker mode", async () => {
      await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(vi.mocked(log.success)).toHaveBeenCalledWith(
        expect.stringContaining("Deleted local spec"),
      );
    });

    it("warns when datasource sync fails in tracker mode", async () => {
      mocks.mockUpdate.mockRejectedValue(new Error("Sync failed"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Could not sync"),
      );
      expect(result.generated).toBe(1);
      expect(unlink).not.toHaveBeenCalled();
    });

    it("creates new issue in file mode with tracker datasource", async () => {
      vi.mocked(isIssueNumbers).mockReturnValue(false);
      vi.mocked(isGlobOrFilePath).mockReturnValue(true);
      mocks.mockGlob.mockResolvedValue(["/tmp/test-cwd/spec1.md"]);
      vi.mocked(readFile).mockResolvedValue("# File Content\n\nBody");

      const result = await runSpecPipeline(baseOpts({ issues: "*.md" }));

      expect(mocks.mockCreate).toHaveBeenCalledWith(
        "Mock Title",
        expect.any(String),
        expect.any(Object),
      );
      expect(unlink).toHaveBeenCalled();
      expect(result.issueNumbers).toContain("99");
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("calls specAgent.cleanup() and instance.cleanup()", async () => {
      await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(mocks.mockAgentCleanup).toHaveBeenCalledOnce();
      expect(mocks.mockProviderCleanup).toHaveBeenCalledOnce();
    });
  });

  // ── Defensive guard ───────────────────────────────────────────────

  describe("defensive guard for null details", () => {
    it("logs error and skips item when details is unexpectedly null in generation loop", async () => {
      // One issue fetches OK, the other fails (producing null details)
      mocks.mockFetch
        .mockResolvedValueOnce({
          number: "1",
          title: "Test Issue",
          body: "Issue body",
          labels: [],
          state: "open",
          url: "https://example.com/1",
          comments: [],
          acceptanceCriteria: "",
        })
        .mockRejectedValueOnce(new Error("Not found"));

      // Patch Array.prototype.filter so the validItems filter lets the
      // null-details item through, simulating a future refactor that
      // might bypass the type-predicate filter.
      const origFilter = Array.prototype.filter;
      let detailsFilterHit = 0;
      vi.spyOn(Array.prototype, "filter").mockImplementation(function (
        this: unknown[],
        cb: any,
        thisArg?: any,
      ) {
        // Identify calls on the items array by checking for `details` key
        if (
          this.length > 0 &&
          typeof this[0] === "object" &&
          this[0] !== null &&
          "details" in this[0]
        ) {
          detailsFilterHit++;
          if (detailsFilterHit === 1) {
            // validItems filter: let ALL items through (including null details)
            return origFilter.call(this, () => true);
          }
        }
        return origFilter.call(this, cb, thisArg);
      });

      const result = await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 2 }));

      // Restore filter before assertions (so test cleanup runs cleanly)
      vi.mocked(Array.prototype.filter).mockRestore();

      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        "Skipping item 2: missing issue details",
      );
      // The null-details item should be counted as failed
      expect(result.failed).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Summary output ──────────────────────────────────────────────

  describe("summary output", () => {
    it("logs dispatch hint for numeric identifiers", async () => {
      await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 1 }));

      expect(vi.mocked(log.dim)).toHaveBeenCalledWith(
        expect.stringContaining("dispatch 1,2"),
      );
    });

    it("includes durationMs and fileDurationsMs in the result", async () => {
      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.fileDurationsMs).toBe("object");
    });
  });

  // ── Rename after generation ─────────────────────────────────────

  describe("rename after generation", () => {
    it("renames spec file based on H1 title in tracker mode", async () => {
      vi.mocked(extractTitle).mockReturnValue("New Title");

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(rename).toHaveBeenCalled();
      expect(result.files.length).toBe(1);
    });
  });

  // ── Large batch confirmation ────────────────────────────────────

  describe("large batch confirmation", () => {
    it("prompts for confirmation when validItems exceeds threshold", async () => {
      const issueNums = Array.from({ length: 101 }, (_, i) => String(i + 1)).join(",");
      mocks.mockFetch.mockResolvedValue({
        number: "1",
        title: "Test Issue",
        body: "Issue body",
        labels: [],
        state: "open",
        url: "https://example.com/1",
        comments: [],
        acceptanceCriteria: "",
      });

      await runSpecPipeline(baseOpts({ issues: issueNums, concurrency: 10 }));

      expect(confirmLargeBatch).toHaveBeenCalledWith(101);
    });

    it("returns early summary when user declines confirmation", async () => {
      vi.mocked(confirmLargeBatch).mockResolvedValue(false);

      const result = await runSpecPipeline(baseOpts({ issues: "1,2", concurrency: 1 }));

      expect(result.total).toBe(0);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.files).toEqual([]);
      expect(mocks.mockGenerate).not.toHaveBeenCalled();
    });
  });

  // ── Error paths ────────────────────────────────────────────

  describe("error paths", () => {
    it("counts generate() exception as failed (not just { success: false })", async () => {
      mocks.mockGenerate.mockRejectedValueOnce(new Error("agent crashed"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1, retries: 0 }));

      expect(result.total).toBe(1);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("Failed to generate spec"),
      );
    });

    it("completes and returns results when provider cleanup() throws", async () => {
      mocks.mockProviderCleanup.mockRejectedValueOnce(new Error("cleanup boom"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      expect(result.total).toBe(1);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.files.length).toBe(1);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Provider cleanup failed"),
      );
    });
  });

  // ── Batch partial-failure ──────────────────────────────────

  describe("batch partial-failure", () => {
    it("succeeds for some items and fails for others in a concurrent batch", async () => {
      mocks.mockFetch
        .mockResolvedValueOnce({
          number: "1",
          title: "Test Issue 1",
          body: "Issue body 1",
          labels: [],
          state: "open",
          url: "https://example.com/1",
          comments: [],
          acceptanceCriteria: "",
        })
        .mockResolvedValueOnce({
          number: "2",
          title: "Test Issue 2",
          body: "Issue body 2",
          labels: [],
          state: "open",
          url: "https://example.com/2",
          comments: [],
          acceptanceCriteria: "",
        })
        .mockResolvedValueOnce({
          number: "3",
          title: "Test Issue 3",
          body: "Issue body 3",
          labels: [],
          state: "open",
          url: "https://example.com/3",
          comments: [],
          acceptanceCriteria: "",
        })
        .mockRejectedValueOnce(new Error("timeout"))
        .mockRejectedValueOnce(new Error("timeout"));

      const result = await runSpecPipeline(baseOpts({ issues: "1,2,3,4,5", concurrency: 2 }));

      expect(result.total).toBe(5);
      expect(result.generated).toBe(3);
      expect(result.failed).toBe(2);
    });

    it("returns error result without throwing when all items fail concurrently", async () => {
      mocks.mockFetch.mockRejectedValue(new Error("service down"));

      const result = await runSpecPipeline(baseOpts({ issues: "1,2,3,4,5", concurrency: 3 }));

      expect(result.total).toBe(5);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(5);
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("No issues could be loaded"),
      );
    });
  });

  // ── Dry-run mode ──────────────────────────────────────────────

  describe("dry-run mode", () => {
    it("returns summary with generated: 0 and does not boot provider", async () => {
      const result = await runSpecPipeline(baseOpts({ dryRun: true, concurrency: 1 }));

      expect(result.generated).toBe(0);
      expect(result.total).toBe(2);
      expect(result.files).toEqual([]);
      expect(result.issueNumbers).toEqual([]);
      expect(vi.mocked(bootProvider)).not.toHaveBeenCalled();
    });

    it("does not call confirmLargeBatch", async () => {
      await runSpecPipeline(baseOpts({ dryRun: true, concurrency: 1 }));

      expect(confirmLargeBatch).not.toHaveBeenCalled();
    });

    it("does not write any files or generate specs", async () => {
      await runSpecPipeline(baseOpts({ dryRun: true, concurrency: 1 }));

      expect(mkdir).not.toHaveBeenCalled();
      expect(mocks.mockGenerate).not.toHaveBeenCalled();
    });

    it("logs a structured preview for each valid item", async () => {
      await runSpecPipeline(baseOpts({ dryRun: true, issues: "1,2", concurrency: 1 }));

      expect(vi.mocked(log.info)).toHaveBeenCalledWith(
        expect.stringContaining("[DRY RUN]"),
      );
      expect(vi.mocked(log.info)).toHaveBeenCalledWith(
        expect.stringContaining("Would generate spec for #1"),
      );
      expect(vi.mocked(log.info)).toHaveBeenCalledWith(
        expect.stringContaining("Would generate spec for #2"),
      );
    });

    it("returns failed count for items that could not be loaded", async () => {
      mocks.mockFetch
        .mockRejectedValueOnce(new Error("Not found"))
        .mockResolvedValueOnce({
          number: "2",
          title: "Test Issue 2",
          body: "Issue body 2",
          labels: [],
          state: "open",
          url: "https://example.com/2",
          comments: [],
          acceptanceCriteria: "",
        });

      const result = await runSpecPipeline(baseOpts({ dryRun: true, issues: "1,2", concurrency: 1 }));

      expect(result.total).toBe(2);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
      expect(vi.mocked(bootProvider)).not.toHaveBeenCalled();
    });

    it("works in file/glob mode", async () => {
      vi.mocked(isIssueNumbers).mockReturnValue(false);
      vi.mocked(isGlobOrFilePath).mockReturnValue(true);
      mocks.mockGlob.mockResolvedValue(["/tmp/test-cwd/spec1.md"]);
      vi.mocked(readFile).mockResolvedValue("# File Content\n\nBody");

      const result = await runSpecPipeline(baseOpts({ dryRun: true, issues: "*.md" }));

      expect(result.generated).toBe(0);
      expect(result.total).toBe(1);
      expect(vi.mocked(bootProvider)).not.toHaveBeenCalled();
      expect(mocks.mockGenerate).not.toHaveBeenCalled();
    });
  });

  // ── Retry logic ──────────────────────────────────────────────

  describe("retry logic", () => {
    beforeEach(() => {
      vi.mocked(confirmLargeBatch).mockResolvedValue(true);
    });

    it("retries spec generation on failure and succeeds on second attempt", async () => {
      mocks.mockGenerate
        .mockRejectedValueOnce(new Error("Transient API error"))
        .mockResolvedValueOnce({
          data: {
            content: "# Generated Spec\n\n## Tasks\n\n- [ ] Do something",
            valid: true,
          },
          success: true,
        });

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1, retries: 1 }));

      expect(mocks.mockGenerate).toHaveBeenCalledTimes(2);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(0);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Attempt 1/2 failed"),
      );
    });

    it("fails after exhausting all retry attempts", async () => {
      mocks.mockGenerate.mockRejectedValue(new Error("Persistent failure"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1, retries: 2 }));

      expect(mocks.mockGenerate).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("does not retry when retries is 0", async () => {
      mocks.mockGenerate.mockRejectedValue(new Error("Immediate failure"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1, retries: 0 }));

      expect(mocks.mockGenerate).toHaveBeenCalledTimes(1);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("uses default retries of 2 when not specified", async () => {
      mocks.mockGenerate.mockRejectedValue(new Error("Always fails"));

      const result = await runSpecPipeline(baseOpts({ issues: "1", concurrency: 1 }));

      // Default retries = 2, so 3 total attempts
      expect(mocks.mockGenerate).toHaveBeenCalledTimes(3);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
    });
  });

  describe("spec generation timeouts", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("uses the default spec timeout when specTimeout is omitted", async () => {
      mocks.mockGenerate.mockImplementation(() => new Promise(() => {}));

      const resultPromise = runSpecPipeline(
        baseOpts({ issues: "1", retries: 0, specTimeout: undefined, concurrency: 1 }),
      );

      await vi.advanceTimersByTimeAsync(600_000);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(mocks.mockGenerate).toHaveBeenCalledTimes(1);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
      expect(mocks.mockUpdate).not.toHaveBeenCalled();
      expect(
        vi.mocked(log.error).mock.calls.some(
          ([message]) =>
            typeof message === "string" &&
            message.includes("Timed out after 600000ms") &&
            message.includes("specAgent.generate(#1)"),
        ),
      ).toBe(true);
    });

    it("retries after a spec generation timeout and succeeds on the next attempt", async () => {
      mocks.mockGenerate
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({
          data: {
            content: "# Generated Spec\n\n## Tasks\n\n- [ ] Do something",
            valid: true,
          },
          success: true,
        });

      const resultPromise = runSpecPipeline(
        baseOpts({ issues: "1", retries: 1, specTimeout: 0.001, concurrency: 1 }),
      );

      await vi.advanceTimersByTimeAsync(60);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(mocks.mockGenerate).toHaveBeenCalledTimes(2);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(0);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Attempt 1/2 failed [specAgent.generate(#1)]"),
      );
    });

    it("runs cleanup and counts the timed out item once when generation times out", async () => {
      mocks.mockGenerate.mockImplementation(() => new Promise(() => {}));

      const resultPromise = runSpecPipeline(
        baseOpts({ issues: "1", retries: 0, specTimeout: 0.001, concurrency: 1 }),
      );

      await vi.advanceTimersByTimeAsync(60);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.generated).toBe(0);
      expect(result.failed).toBe(1);
      expect(mocks.mockAgentCleanup).toHaveBeenCalledOnce();
      expect(mocks.mockProviderCleanup).toHaveBeenCalledOnce();
      expect(mocks.mockUpdate).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it("fails only the timed out item and still completes the rest of the batch", async () => {
      mocks.mockGenerate
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({
          data: {
            content: "# Generated Spec\n\n## Tasks\n\n- [ ] Do something",
            valid: true,
          },
          success: true,
        })
        .mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = runSpecPipeline(
        baseOpts({ issues: "1,2", retries: 1, specTimeout: 0.001, concurrency: 2 }),
      );

      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(60);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.total).toBe(2);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(1);
      expect(mocks.mockGenerate).toHaveBeenCalledTimes(3);
      expect(mocks.mockUpdate).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(mocks.mockAgentCleanup).toHaveBeenCalledOnce();
      expect(mocks.mockProviderCleanup).toHaveBeenCalledOnce();
    });
  });
});
