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

// ─── Imports (AFTER vi.mock calls) ──────────────────────────────────

import { boot, type RawCliArgs } from "../orchestrator/runner.js";
import { log } from "../helpers/logger.js";
import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { resolveSource } from "../spec-generator.js";
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

  it("exits with error when --fix-tests is combined with issue IDs", async () => {
    const runner = await boot({ cwd: "/tmp/test" });

    await expect(
      runner.runFromCli(createRawCliArgs({ fixTests: true, issueIds: ["1"] })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith("--fix-tests cannot be combined with issue IDs");
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
