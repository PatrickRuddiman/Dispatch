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
  DEFAULT_SPEC_TIMEOUT_MIN: 10,
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

vi.mock("../orchestrator/datasource-helpers.js", () => ({
  parseIssueFilename: vi.fn(),
}));

vi.mock("../mcp/state/database.js", () => ({
  openDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock("../mcp/state/manager.js", () => ({
  createRun: vi.fn().mockReturnValue("test-run-id"),
  createSpecRun: vi.fn().mockReturnValue("test-spec-run-id"),
  getRun: vi.fn().mockReturnValue({ runId: "test-run-id", status: "completed", total: 0, completed: 0, failed: 0 }),
  getSpecRun: vi.fn().mockReturnValue({ runId: "test-spec-run-id", status: "completed", total: 0, generated: 0, failed: 0 }),
  getTasksForRun: vi.fn().mockReturnValue([]),
  markOrphanedRunsFailed: vi.fn(),
  listResumableSessions: vi.fn().mockReturnValue([]),
  requeueSessionRuns: vi.fn().mockReturnValue([]),
  waitForRunCompletion: vi.fn().mockResolvedValue(true),
  registerLiveRun: vi.fn(),
  unregisterLiveRun: vi.fn(),
  addLogCallback: vi.fn(),
  emitLog: vi.fn(),
}));

vi.mock("../queue/run-queue.js", () => ({
  initRunQueue: vi.fn(),
  getRunQueue: vi.fn().mockReturnValue({ enqueue: vi.fn(), drain: vi.fn(), abort: vi.fn() }),
  resetRunQueue: vi.fn(),
}));

vi.mock("../config.js", () => ({
  CONFIG_BOUNDS: { maxRuns: { min: 1, max: 32 }, concurrency: { min: 1, max: 64 }, planTimeout: { min: 1, max: 120 }, specTimeout: { min: 1, max: 120 }, specWarnTimeout: { min: 1, max: 120 }, specKillTimeout: { min: 1, max: 120 } },
}));

// ─── Imports (AFTER vi.mock calls) ──────────────────────────────────

import { boot, type RawCliArgs } from "../orchestrator/runner.js";
import { log } from "../helpers/logger.js";
import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { DEFAULT_SPEC_TIMEOUT_MIN, resolveSource } from "../spec-generator.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";
import { runDispatchPipeline } from "../orchestrator/dispatch-pipeline.js";

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
    const args = createRawCliArgs({ issueIds: ["1"], dryRun: true });
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(args);

    expect(resolveCliConfig).toHaveBeenCalledWith(args);
  });

  it("routes to dispatch pipeline in dry-run mode", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ issueIds: ["1", "2"], dryRun: true }));

    expect(runDispatchPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: ["1", "2"], dryRun: true }),
      "/tmp/test",
    );
  });

  it("creates a queued run via the DB in non-dry-run dispatch mode", async () => {
    const { createRun } = await import("../mcp/state/manager.js");
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ issueIds: ["1", "2"] }));

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      issueIds: ["1", "2"],
      status: "queued",
      workerMessage: expect.any(String),
      sessionId: expect.any(String),
    }));
  });

  it("routes to spec pipeline in dry-run mode when --spec is set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ spec: "1,2", dryRun: true }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", provider: "copilot", cwd: "/tmp/test-cwd", specTimeout: DEFAULT_SPEC_TIMEOUT_MIN }),
    );
    expect(runDispatchPipeline).not.toHaveBeenCalled();
  });

  it("creates a queued spec run via the DB in non-dry-run spec mode", async () => {
    const { createSpecRun } = await import("../mcp/state/manager.js");
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ spec: "1,2" }));

    expect(createSpecRun).toHaveBeenCalledWith(expect.objectContaining({
      issues: "1,2",
      status: "queued",
      workerMessage: expect.any(String),
      sessionId: expect.any(String),
    }));
  });

  it("forwards retries to spec generation in dry-run mode", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ spec: "1,2", retries: 3, dryRun: true }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", retries: 3 }),
    );
  });

  it("forwards explicit specTimeout to spec pipeline in dry-run mode", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ spec: "1,2", specTimeout: 7.5, dryRun: true }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", specTimeout: 7.5 }),
    );
  });

  it("uses default specTimeout when omitted in dry-run spec mode", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ spec: "1,2", specTimeout: undefined, dryRun: true }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "1,2", specTimeout: DEFAULT_SPEC_TIMEOUT_MIN }),
    );
  });

  it("forwards explicit specTimeout to spec pipeline for --respec in dry-run mode", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ respec: "7", specTimeout: 7.5, dryRun: true }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "7", specTimeout: 7.5 }),
    );
  });

  it("uses default specTimeout when omitted in dry-run respec mode", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ respec: "7", specTimeout: undefined, dryRun: true }));

    expect(runSpecPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ issues: "7", specTimeout: DEFAULT_SPEC_TIMEOUT_MIN }),
    );
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

  it("uses defaultConcurrency in dry-run mode when concurrency is not set", async () => {
    const runner = await boot({ cwd: "/tmp/test" });
    await runner.runFromCli(createRawCliArgs({ issueIds: ["1"], dryRun: true }));

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

  it("propagates errors from the dispatch pipeline in dry-run mode", async () => {
    vi.mocked(runDispatchPipeline).mockRejectedValue(new Error("dispatch error"));

    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ issueIds: ["1"], dryRun: true })),
    ).rejects.toThrow("dispatch error");
  });

  it("propagates errors from the spec pipeline in dry-run mode", async () => {
    vi.mocked(runSpecPipeline).mockRejectedValue(new Error("spec error"));

    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ spec: "1", dryRun: true })),
    ).rejects.toThrow("spec error");
  });
});
