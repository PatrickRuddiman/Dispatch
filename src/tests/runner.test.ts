import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ─── Module-level mocks (MUST come before imports of mocked modules) ───

vi.mock("../helpers/logger.js", () => ({
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
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("../orchestrator/cli-config.js", () => ({
  resolveCliConfig: vi.fn<(args: unknown) => Promise<unknown>>().mockImplementation(async (args) => args),
}));

vi.mock("../spec-generator.js", () => ({
  resolveSource: vi.fn().mockResolvedValue("md"),
  defaultConcurrency: vi.fn().mockReturnValue(2),
  isIssueNumbers: vi.fn(),
}));

vi.mock("../datasources/index.js", () => ({
  getDatasource: vi.fn(),
}));

vi.mock("../orchestrator/spec-pipeline.js", () => ({
  runSpecPipeline: vi.fn().mockResolvedValue({
    total: 0,
    generated: 0,
    failed: 0,
    files: [],
    issueNumbers: [],
    durationMs: 0,
    fileDurationsMs: {},
  }),
}));

vi.mock("../orchestrator/dispatch-pipeline.js", () => ({
  runDispatchPipeline: vi.fn().mockResolvedValue({
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    results: [],
  }),
}));

vi.mock("../orchestrator/fix-tests-pipeline.js", () => ({
  runFixTestsPipeline: vi.fn().mockResolvedValue({ mode: "fix-tests", success: true }),
}));

vi.mock("../helpers/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue("/tmp/test-worktree"),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../orchestrator/datasource-helpers.js", () => ({
  fetchItemsById: vi.fn().mockResolvedValue([]),
  parseIssueFilename: vi.fn(),
}));

// ─── Imports (AFTER vi.mock calls) ──────────────────────────────────

import { boot, type RawCliArgs } from "../orchestrator/runner.js";
import { log } from "../helpers/logger.js";
import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { resolveSource } from "../spec-generator.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";
import { runDispatchPipeline } from "../orchestrator/dispatch-pipeline.js";
import { runFixTestsPipeline } from "../orchestrator/fix-tests-pipeline.js";
import { createWorktree, removeWorktree } from "../helpers/worktree.js";
import { fetchItemsById } from "../orchestrator/datasource-helpers.js";
import { getDatasource } from "../datasources/index.js";
import { registerCleanup } from "../helpers/cleanup.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createRawCliArgs(overrides?: Partial<RawCliArgs>): RawCliArgs {
  return {
    issueIds: [],
    dryRun: false,
    noPlan: false,
    noBranch: false,
    noWorktree: false,
    force: false,
    provider: "copilot",
    cwd: "/tmp/test-cwd",
    verbose: false,
    explicitFlags: new Set(["provider", "issueSource"]),
    issueSource: "md",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("boot()", () => {
  it("returns an OrchestratorAgent with orchestrate, generateSpecs, run, and runFromCli methods", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    expect(typeof runner.orchestrate).toBe("function");
    expect(typeof runner.generateSpecs).toBe("function");
    expect(typeof runner.run).toBe("function");
    expect(typeof runner.runFromCli).toBe("function");
  });
});

describe("orchestrate()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runDispatchPipeline).mockResolvedValue({
      total: 0, completed: 0, failed: 0, skipped: 0, results: [],
    });
  });

  it("delegates to runDispatchPipeline with options and cwd", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.orchestrate({ issueIds: ["1"], dryRun: false, concurrency: 2 });

    expect(runDispatchPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: ["1"], dryRun: false }),
      "/tmp/test",
    );
  });

  it("returns the DispatchSummary from the pipeline", async () => {
    const summary = { total: 3, completed: 2, failed: 1, skipped: 0, results: [] };
    vi.mocked(runDispatchPipeline).mockResolvedValue(summary);

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.orchestrate({ issueIds: ["1"], dryRun: false });

    expect(result).toEqual(summary);
  });
});

describe("generateSpecs()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSpecPipeline).mockResolvedValue({
      total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: 0, fileDurationsMs: {},
    });
  });

  it("delegates to runSpecPipeline with spec options", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.generateSpecs({ issues: "1,2", provider: "copilot", cwd: "/tmp/test" });

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", provider: "copilot", cwd: "/tmp/test" }),
    );
  });

  it("returns the SpecSummary from the pipeline", async () => {
    const summary = { total: 2, generated: 2, failed: 0, files: ["a.md"], issueNumbers: ["1"], durationMs: 100, fileDurationsMs: {} };
    vi.mocked(runSpecPipeline).mockResolvedValue(summary);

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.generateSpecs({ issues: "1", provider: "copilot", cwd: "/tmp/test" });

    expect(result).toEqual(summary);
  });
});

describe("run()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSpecPipeline).mockResolvedValue({
      total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: 0, fileDurationsMs: {},
    });
    vi.mocked(runDispatchPipeline).mockResolvedValue({
      total: 0, completed: 0, failed: 0, skipped: 0, results: [],
    });
  });

  it("routes to generateSpecs when mode is 'spec'", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.run({ mode: "spec", issues: "1,2", provider: "copilot" });

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", provider: "copilot", cwd: "/tmp/test" }),
    );
    expect(runDispatchPipeline).not.toHaveBeenCalled();
  });

  it("routes to runFixTestsPipeline when mode is 'fix-tests'", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.run({ mode: "fix-tests" });

    const { runFixTestsPipeline } = await import("../orchestrator/fix-tests-pipeline.js");
    expect(runFixTestsPipeline).toHaveBeenCalledWith({
      cwd: "/tmp/test", provider: "opencode", serverUrl: undefined, verbose: false,
    });
    expect(runDispatchPipeline).not.toHaveBeenCalled();
    expect(runSpecPipeline).not.toHaveBeenCalled();
  });

  it("routes to orchestrate when mode is 'dispatch'", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.run({ mode: "dispatch", issueIds: ["1"], dryRun: false });

    expect(runDispatchPipeline).toHaveBeenCalled();
    expect(runSpecPipeline).not.toHaveBeenCalled();
  });

  it("strips the mode discriminator before delegating to orchestrate", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.run({ mode: "dispatch", issueIds: ["5"], dryRun: true, concurrency: 3 });

    expect(runDispatchPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: ["5"], dryRun: true, concurrency: 3 }),
      "/tmp/test",
    );
    expect(vi.mocked(runDispatchPipeline).mock.calls[0][0]).not.toHaveProperty("mode");
  });
});

describe("runFromCli()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    vi.mocked(resolveCliConfig).mockImplementation(async (args) => args);
    vi.mocked(resolveSource).mockResolvedValue("md");
    vi.mocked(runSpecPipeline).mockResolvedValue({
      total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: 0, fileDurationsMs: {},
    });
    vi.mocked(runDispatchPipeline).mockResolvedValue({
      total: 0, completed: 0, failed: 0, skipped: 0, results: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls resolveCliConfig with the raw args", async () => {
    const args = createRawCliArgs({ issueIds: ["1"] });
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(args);

    expect(resolveCliConfig).toHaveBeenCalledWith(args);
  });

  it("routes to dispatch pipeline when no spec/respec/fixTests flags", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ issueIds: ["1", "2"] }));

    expect(runDispatchPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: ["1", "2"] }),
      "/tmp/test",
    );
  });

  it("routes to spec pipeline when --spec is set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ spec: "1,2" }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", provider: "copilot", cwd: "/tmp/test-cwd" }),
    );
    expect(runDispatchPipeline).not.toHaveBeenCalled();
  });

  it("routes to fix-tests pipeline when --fix-tests is set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ fixTests: true }));

    const { runFixTestsPipeline } = await import("../orchestrator/fix-tests-pipeline.js");
    expect(runFixTestsPipeline).toHaveBeenCalled();
    expect(runDispatchPipeline).not.toHaveBeenCalled();
    expect(runSpecPipeline).not.toHaveBeenCalled();
  });

  it("exits with error when --spec and --fix-tests are both set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ spec: "1", fixTests: true })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
  });

  it("exits with error when --respec and --fix-tests are both set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ respec: "1", fixTests: true })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
  });

  it("routes to fix-tests pipeline in worktrees when --fix-tests is combined with issue IDs", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn().mockReturnValue("user/42-fix-bug"),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([
      { number: "42", title: "Fix bug", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
    ]);
    vi.mocked(createWorktree).mockResolvedValue("/tmp/worktree-42");
    vi.mocked(runFixTestsPipeline).mockResolvedValue({ mode: "fix-tests", success: true });

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["42"] }));

    expect(fetchItemsById).toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalled();
    expect(runFixTestsPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree-42" }),
    );
    expect(result).toMatchObject({ mode: "fix-tests", success: true, issueResults: expect.any(Array) });
  });

  it("returns failure when no issues found for fix-tests with issue IDs", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn(),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([]);

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["999"] }));

    expect(result).toMatchObject({ mode: "fix-tests", success: false });
  });

  it("calls getDatasource and fetchItemsById with correct arguments for multi-issue fix-tests", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn().mockReturnValue("testuser/10-some-issue"),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([
      { number: "10", title: "Some issue", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
    ]);
    vi.mocked(createWorktree).mockResolvedValue("/tmp/worktree-10");
    vi.mocked(runFixTestsPipeline).mockResolvedValue({ mode: "fix-tests", success: true });

    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["10"], issueSource: "md" }));

    expect(getDatasource).toHaveBeenCalledWith("md");
    expect(fetchItemsById).toHaveBeenCalledWith(
      ["10"],
      mockDatasource,
      expect.objectContaining({ cwd: "/tmp/test-cwd" }),
    );
  });

  it("creates and cleans up worktrees for multiple issues", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn()
        .mockReturnValueOnce("testuser/1-first-issue")
        .mockReturnValueOnce("testuser/2-second-issue"),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([
      { number: "1", title: "First issue", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
      { number: "2", title: "Second issue", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
    ]);
    vi.mocked(createWorktree)
      .mockResolvedValueOnce("/tmp/worktree-1")
      .mockResolvedValueOnce("/tmp/worktree-2");
    vi.mocked(runFixTestsPipeline).mockResolvedValue({ mode: "fix-tests", success: true });

    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["1", "2"] }));

    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(createWorktree).toHaveBeenCalledWith("/tmp/test-cwd", "1-fix-tests.md", "testuser/1-first-issue");
    expect(createWorktree).toHaveBeenCalledWith("/tmp/test-cwd", "2-fix-tests.md", "testuser/2-second-issue");

    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(removeWorktree).toHaveBeenCalledWith("/tmp/test-cwd", "1-fix-tests.md");
    expect(removeWorktree).toHaveBeenCalledWith("/tmp/test-cwd", "2-fix-tests.md");

    expect(registerCleanup).toHaveBeenCalledTimes(2);
  });

  it("aggregates per-issue results when all issues succeed", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn()
        .mockReturnValueOnce("testuser/5-fix-login")
        .mockReturnValueOnce("testuser/6-fix-logout"),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([
      { number: "5", title: "Fix login", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
      { number: "6", title: "Fix logout", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
    ]);
    vi.mocked(createWorktree)
      .mockResolvedValueOnce("/tmp/worktree-5")
      .mockResolvedValueOnce("/tmp/worktree-6");
    vi.mocked(runFixTestsPipeline).mockResolvedValue({ mode: "fix-tests", success: true });

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["5", "6"] }));

    expect(result).toEqual({
      mode: "fix-tests",
      success: true,
      issueResults: [
        { issueId: "5", branch: "testuser/5-fix-login", success: true, error: undefined },
        { issueId: "6", branch: "testuser/6-fix-logout", success: true, error: undefined },
      ],
    });
  });

  it("aggregates per-issue results with mixed success and failure", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn()
        .mockReturnValueOnce("testuser/7-works")
        .mockReturnValueOnce("testuser/8-broken"),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([
      { number: "7", title: "Works", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
      { number: "8", title: "Broken", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
    ]);
    vi.mocked(createWorktree)
      .mockResolvedValueOnce("/tmp/worktree-7")
      .mockResolvedValueOnce("/tmp/worktree-8");
    vi.mocked(runFixTestsPipeline)
      .mockResolvedValueOnce({ mode: "fix-tests", success: true })
      .mockResolvedValueOnce({ mode: "fix-tests", success: false, error: "Tests still failing" });

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["7", "8"] }));

    expect(result).toMatchObject({ mode: "fix-tests", success: false });
    const summary = result as { issueResults: Array<{ issueId: string; branch: string; success: boolean; error?: string }> };
    expect(summary.issueResults).toHaveLength(2);
    expect(summary.issueResults[0]).toEqual({ issueId: "7", branch: "testuser/7-works", success: true, error: undefined });
    expect(summary.issueResults[1]).toEqual({ issueId: "8", branch: "testuser/8-broken", success: false, error: "Tests still failing" });
  });

  it("cleans up worktrees even when pipeline throws", async () => {
    const mockDatasource = {
      name: "github" as const,
      buildBranchName: vi.fn().mockReturnValue("testuser/99-crash"),
      getUsername: vi.fn().mockResolvedValue("testuser"),
    };
    vi.mocked(getDatasource).mockReturnValue(mockDatasource as any);
    vi.mocked(fetchItemsById).mockResolvedValue([
      { number: "99", title: "Crash", body: "", labels: [], state: "open", url: "", comments: [], acceptanceCriteria: "" },
    ]);
    vi.mocked(createWorktree).mockResolvedValue("/tmp/worktree-99");
    vi.mocked(runFixTestsPipeline).mockRejectedValue(new Error("pipeline exploded"));

    const runner = await boot({ cwd: "/tmp/test" });
    const result = await runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["99"] }));

    expect(removeWorktree).toHaveBeenCalledWith("/tmp/test-cwd", "99-fix-tests.md");
    expect(result).toMatchObject({
      mode: "fix-tests",
      success: false,
      issueResults: [
        expect.objectContaining({ issueId: "99", success: false, error: "pipeline exploded" }),
      ],
    });
  });

  it("exits with error when --feature and --no-branch are both set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ feature: true, noBranch: true })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith(
      "--feature and --no-branch are mutually exclusive",
    );
  });

  it("exits with error when --feature and --spec are both set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ feature: true, spec: "1" })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
  });

  it("exits with error when --feature and --fix-tests are both set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ feature: true, fixTests: true })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
  });

  it("uses defaultConcurrency when concurrency is not set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ issueIds: ["1"] }));

    expect(runDispatchPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 2 }),
      "/tmp/test",
    );
  });

  it("propagates errors from resolveCliConfig", async () => {
    vi.mocked(resolveCliConfig).mockRejectedValue(new Error("config error"));

    const runner = await boot({ cwd: "/tmp/test" });

    await expect(runner.runFromCli(createRawCliArgs())).rejects.toThrow("config error");
  });

  it("propagates errors from the dispatch pipeline", async () => {
    vi.mocked(runDispatchPipeline).mockRejectedValue(new Error("dispatch error"));

    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ issueIds: ["1"] })),
    ).rejects.toThrow("dispatch error");
  });

  it("propagates errors from the spec pipeline", async () => {
    vi.mocked(runSpecPipeline).mockRejectedValue(new Error("spec error"));

    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ spec: "1" })),
    ).rejects.toThrow("spec error");
  });
});
