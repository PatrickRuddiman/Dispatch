import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ─── Module-level mocks (MUST come before imports of mocked modules) ───

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

// ─── Imports (AFTER vi.mock calls) ──────────────────────────────────

import { boot, type RawCliArgs } from "../agents/orchestrator.js";
import { log } from "../logger.js";
import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { resolveSource } from "../spec-generator.js";
import { getDatasource } from "../datasources/index.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";
import { runDispatchPipeline } from "../orchestrator/dispatch-pipeline.js";
import type { IssueDetails, Datasource } from "../datasources/interface.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createRawCliArgs(overrides?: Partial<RawCliArgs>): RawCliArgs {
  return {
    issueIds: [],
    dryRun: false,
    noPlan: false,
    noBranch: false,
    provider: "copilot",
    cwd: "/tmp/test-cwd",
    verbose: false,
    explicitFlags: new Set(["provider", "issueSource"]),
    issueSource: "md",
    ...overrides,
  };
}

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

function createMockDatasource(overrides?: Partial<Datasource>): Datasource {
  return {
    name: "md",
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
    commitAllChanges: vi.fn<Datasource["commitAllChanges"]>().mockResolvedValue(undefined),
    createPullRequest: vi.fn<Datasource["createPullRequest"]>().mockResolvedValue("https://github.com/org/repo/pull/1"),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("--respec routing in runFromCli()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    // Restore default mock implementations after clearAllMocks resets them
    vi.mocked(resolveCliConfig).mockImplementation(async (args) => args);
    vi.mocked(resolveSource).mockResolvedValue("md");
    vi.mocked(runSpecPipeline).mockResolvedValue({
      total: 0,
      generated: 0,
      failed: 0,
      files: [],
      issueNumbers: [],
      durationMs: 0,
      fileDurationsMs: {},
    });
    vi.mocked(runDispatchPipeline).mockResolvedValue({
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      results: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Discovery path (empty respec) ─────────────────────────────

  it("discovers existing specs via datasource.list() when respec is an empty array", async () => {
    const mockDs = createMockDatasource({
      list: vi.fn<Datasource["list"]>().mockResolvedValue([
        createIssueDetails({ number: "1", title: "First issue" }),
        createIssueDetails({ number: "2", title: "Second issue" }),
      ]),
    });
    vi.mocked(getDatasource).mockReturnValue(mockDs);
    vi.mocked(resolveSource).mockResolvedValue("md");

    const agent = await boot({ cwd: "/tmp/test" });
    await agent.runFromCli(createRawCliArgs({ respec: [] }));

    expect(resolveSource).toHaveBeenCalled();
    expect(getDatasource).toHaveBeenCalledWith("md");
    expect(mockDs.list).toHaveBeenCalledOnce();
    expect(mockDs.list).toHaveBeenCalledWith({ cwd: "/tmp/test-cwd", org: undefined, project: undefined });
    expect(runSpecPipeline).toHaveBeenCalledOnce();
    expect(runSpecPipeline).toHaveBeenCalledWith({
      issues: "1,2",
      issueSource: "md",
      provider: "copilot",
      serverUrl: undefined,
      cwd: "/tmp/test-cwd",
      outputDir: undefined,
      org: undefined,
      project: undefined,
      concurrency: undefined,
    });
  });

  // ─── Direct delegation (respec with arguments) ─────────────────

  it("delegates directly to generateSpecs() when respec has issue numbers", async () => {
    const agent = await boot({ cwd: "/tmp/test" });
    await agent.runFromCli(createRawCliArgs({ respec: "5,10" }));

    expect(getDatasource).not.toHaveBeenCalled();
    expect(resolveSource).not.toHaveBeenCalled();
    expect(runSpecPipeline).toHaveBeenCalledOnce();
    expect(runSpecPipeline).toHaveBeenCalledWith({
      issues: "5,10",
      issueSource: "md",
      provider: "copilot",
      serverUrl: undefined,
      cwd: "/tmp/test-cwd",
      outputDir: undefined,
      org: undefined,
      project: undefined,
      concurrency: undefined,
    });
  });

  it("delegates directly to generateSpecs() when respec has file paths", async () => {
    const agent = await boot({ cwd: "/tmp/test" });
    await agent.runFromCli(createRawCliArgs({ respec: ["src/**/*.md", "docs/*.md"] }));

    expect(runSpecPipeline).toHaveBeenCalledOnce();
    expect(runSpecPipeline).toHaveBeenCalledWith({
      issues: ["src/**/*.md", "docs/*.md"],
      issueSource: "md",
      provider: "copilot",
      serverUrl: undefined,
      cwd: "/tmp/test-cwd",
      outputDir: undefined,
      org: undefined,
      project: undefined,
      concurrency: undefined,
    });
  });

  // ─── Mutual exclusion ─────────────────────────────────────────

  it("exits with error when both --spec and --respec are provided", async () => {
    const agent = await boot({ cwd: "/tmp/test" });

    await expect(
      agent.runFromCli(createRawCliArgs({ spec: "1,2", respec: "3,4" })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith("--spec and --respec are mutually exclusive");
    expect(runSpecPipeline).not.toHaveBeenCalled();
  });

  // ─── Empty discovery errors ───────────────────────────────────

  it("exits with error when respec discovers no existing specs", async () => {
    const mockDs = createMockDatasource({
      list: vi.fn<Datasource["list"]>().mockResolvedValue([]),
    });
    vi.mocked(getDatasource).mockReturnValue(mockDs);
    vi.mocked(resolveSource).mockResolvedValue("md");

    const agent = await boot({ cwd: "/tmp/test" });

    await expect(
      agent.runFromCli(createRawCliArgs({ respec: [] })),
    ).rejects.toThrow("process.exit called");

    expect(log.error).toHaveBeenCalledWith("No existing specs found to regenerate");
    expect(runSpecPipeline).not.toHaveBeenCalled();
  });

  // ─── Identifier formatting ────────────────────────────────────

  it("joins numeric identifiers with commas when all are numeric", async () => {
    const mockDs = createMockDatasource({
      list: vi.fn<Datasource["list"]>().mockResolvedValue([
        createIssueDetails({ number: "42" }),
        createIssueDetails({ number: "99" }),
        createIssueDetails({ number: "7" }),
      ]),
    });
    vi.mocked(getDatasource).mockReturnValue(mockDs);
    vi.mocked(resolveSource).mockResolvedValue("md");

    const agent = await boot({ cwd: "/tmp/test" });
    await agent.runFromCli(createRawCliArgs({ respec: [] }));

    expect(runSpecPipeline).toHaveBeenCalledOnce();
    expect(vi.mocked(runSpecPipeline).mock.calls[0][0]).toHaveProperty("issues", "42,99,7");
  });

  it("passes identifiers as array when not all are numeric", async () => {
    const mockDs = createMockDatasource({
      list: vi.fn<Datasource["list"]>().mockResolvedValue([
        createIssueDetails({ number: "42" }),
        createIssueDetails({ number: "feature-auth" }),
        createIssueDetails({ number: "7" }),
      ]),
    });
    vi.mocked(getDatasource).mockReturnValue(mockDs);
    vi.mocked(resolveSource).mockResolvedValue("md");

    const agent = await boot({ cwd: "/tmp/test" });
    await agent.runFromCli(createRawCliArgs({ respec: [] }));

    expect(runSpecPipeline).toHaveBeenCalledOnce();
    expect(vi.mocked(runSpecPipeline).mock.calls[0][0]).toHaveProperty("issues", ["42", "feature-auth", "7"]);
  });

  // ─── resolveSource failure ────────────────────────────────────

  it("exits with error when resolveSource returns null for empty respec", async () => {
    vi.mocked(resolveSource).mockResolvedValue(null);

    const agent = await boot({ cwd: "/tmp/test" });

    await expect(
      agent.runFromCli(createRawCliArgs({ respec: [] })),
    ).rejects.toThrow("process.exit called");

    expect(runSpecPipeline).not.toHaveBeenCalled();
  });
});
