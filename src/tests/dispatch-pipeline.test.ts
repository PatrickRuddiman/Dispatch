import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskFile } from "../parser.js";
import type { PlanResult, PlannerAgent } from "../agents/planner.js";
import type { ProviderInstance } from "../providers/interface.js";
import type { Datasource, IssueDetails } from "../datasources/interface.js";

// ─── Hoisted mock references and fixtures ───────────────────────────

const { mocks, TASK_FIXTURE, TASK_FILE_FIXTURE } = vi.hoisted(() => {
  const TASK_FIXTURE: Task = {
    index: 0,
    text: "Implement the feature",
    line: 3,
    raw: "- [ ] Implement the feature",
    file: "/tmp/dispatch-test/1-test.md",
  };

  const TASK_FILE_FIXTURE: TaskFile = {
    path: "/tmp/dispatch-test/1-test.md",
    tasks: [TASK_FIXTURE],
    content: "# Test\n\n- [ ] Implement the feature",
  };

  const mockPlan = vi.fn<PlannerAgent["plan"]>();
  const mockExecute = vi.fn();
  const mockCreateSession = vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("sess-1");
  const mockPrompt = vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done");
  const mockCleanup = vi.fn().mockResolvedValue(undefined);

  return {
    mocks: { mockPlan, mockExecute, mockCreateSession, mockPrompt, mockCleanup },
    TASK_FIXTURE,
    TASK_FILE_FIXTURE,
  };
});

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("../providers/index.js", () => ({
  bootProvider: vi.fn().mockResolvedValue({
    name: "mock",
    model: "mock-model",
    createSession: mocks.mockCreateSession,
    prompt: mocks.mockPrompt,
    cleanup: mocks.mockCleanup,
  } satisfies ProviderInstance),
}));

vi.mock("../agents/planner.js", () => ({
  boot: vi.fn().mockResolvedValue({
    name: "planner",
    plan: mocks.mockPlan,
    cleanup: vi.fn().mockResolvedValue(undefined),
  } satisfies PlannerAgent),
}));

vi.mock("../agents/executor.js", () => ({
  boot: vi.fn().mockResolvedValue({
    name: "executor",
    execute: mocks.mockExecute,
    cleanup: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../datasources/index.js", () => ({
  getDatasource: vi.fn().mockReturnValue({
    name: "md",
    list: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockResolvedValue({} as IssueDetails),
    update: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({} as IssueDetails),
    getDefaultBranch: vi.fn().mockResolvedValue("main"),
    buildBranchName: vi.fn().mockReturnValue("dispatch/1-test"),
    createAndSwitchBranch: vi.fn().mockResolvedValue(undefined),
    switchBranch: vi.fn().mockResolvedValue(undefined),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    commitAllChanges: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue("https://example.com/pr/1"),
  } satisfies Datasource),
}));

vi.mock("../tui.js", () => ({
  createTui: vi.fn().mockReturnValue({
    state: {
      tasks: [],
      phase: "discovering",
      startTime: Date.now(),
      filesFound: 0,
    },
    stop: vi.fn(),
  }),
}));

vi.mock("../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

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
  },
}));

vi.mock("../parser.js", () => ({
  parseTaskFile: vi.fn().mockResolvedValue(TASK_FILE_FIXTURE),
  buildTaskContext: vi.fn().mockReturnValue("filtered context"),
  groupTasksByMode: vi.fn().mockImplementation((tasks: Task[]) => [tasks]),
}));

vi.mock("../orchestrator/datasource-helpers.js", () => ({
  fetchItemsById: vi.fn().mockResolvedValue([{
    number: "1",
    title: "Test",
    body: "# Test\n\n- [ ] Implement the feature",
    labels: [],
    state: "open",
    url: "https://example.com/1",
    comments: [],
    acceptanceCriteria: "",
  }]),
  writeItemsToTempDir: vi.fn().mockResolvedValue({
    files: ["/tmp/dispatch-test/1-test.md"],
    issueDetailsByFile: new Map([["/tmp/dispatch-test/1-test.md", {
      number: "1",
      title: "Test",
      body: "# Test\n\n- [ ] Implement the feature",
      labels: [],
      state: "open",
      url: "https://example.com/1",
      comments: [],
      acceptanceCriteria: "",
    }]]),
  }),
  closeCompletedSpecIssues: vi.fn().mockResolvedValue(undefined),
  parseIssueFilename: vi.fn().mockReturnValue({ issueId: "1", slug: "test" }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("- [x] Implement the feature"),
}));

// ─── Import function under test (after mocks) ──────────────────────

import { runDispatchPipeline, dryRunMode } from "../orchestrator/dispatch-pipeline.js";
import { log } from "../helpers/logger.js";
import { createTui } from "../tui.js";

// ─── Helpers ────────────────────────────────────────────────────────

function baseOpts(overrides?: Partial<Parameters<typeof runDispatchPipeline>[0]>) {
  return {
    issueIds: ["1"],
    concurrency: 1,
    dryRun: false,
    noPlan: false,
    noBranch: true,
    provider: "opencode" as const,
    source: "md" as const,
    planTimeout: 1,   // 1 minute = 60_000ms
    planRetries: 1,   // 1 retry = 2 total attempts
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("planning timeout and retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Reset the executor mock to default success
    mocks.mockExecute.mockResolvedValue({
      success: true,
      dispatchResult: { task: TASK_FIXTURE, success: true },
      elapsedMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds when planning completes within the timeout", async () => {
    mocks.mockPlan.mockImplementation(() =>
      new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 100);
      }),
    );

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.mockPlan).toHaveBeenCalledOnce();
    expect(mocks.mockExecute).toHaveBeenCalledOnce();
  });

  it("retries after timeout and succeeds on the second attempt", async () => {
    let callCount = 0;
    mocks.mockPlan.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First attempt: never resolves within timeout (hangs for 2 minutes)
        return new Promise<PlanResult>((resolve) => {
          setTimeout(() => resolve({ prompt: "too late", success: true }), 120_000);
        });
      }
      // Second attempt: succeeds quickly
      return new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 100);
      });
    });

    const resultPromise = runDispatchPipeline(baseOpts({ planTimeout: 1, planRetries: 1 }), "/tmp/test");

    // Advance past the first attempt's timeout (1 min = 60_000ms)
    await vi.advanceTimersByTimeAsync(60_000);
    // Advance past the second attempt's 100ms
    await vi.advanceTimersByTimeAsync(100);
    // Flush any remaining timers for executor phase
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Planning timed out"),
    );
    expect(mocks.mockExecute).toHaveBeenCalledOnce();
  });

  it("fails the task when all planning attempts time out", async () => {
    // Both attempts hang forever
    mocks.mockPlan.mockImplementation(
      () => new Promise<PlanResult>(() => {}), // never resolves
    );

    const resultPromise = runDispatchPipeline(baseOpts({ planTimeout: 1, planRetries: 1 }), "/tmp/test");

    // Advance past first timeout
    await vi.advanceTimersByTimeAsync(60_000);
    // Advance past second timeout
    await vi.advanceTimersByTimeAsync(60_000);
    // Flush remaining
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(2);
    // Executor should NOT have been called since planning failed
    expect(mocks.mockExecute).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Planning timed out"),
    );
  });

  it("does not retry when planning fails with a non-timeout error", async () => {
    mocks.mockPlan.mockRejectedValue(new Error("Provider connection refused"));

    const resultPromise = runDispatchPipeline(baseOpts({ planRetries: 2 }), "/tmp/test");
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    // Should only be called once — no retry for non-timeout errors
    expect(mocks.mockPlan).toHaveBeenCalledOnce();
    expect(mocks.mockExecute).not.toHaveBeenCalled();
  });

  it("skips planning entirely when noPlan is true", async () => {
    const resultPromise = runDispatchPipeline(baseOpts({ noPlan: true }), "/tmp/test");
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    // Planner should never be called in --no-plan mode
    expect(mocks.mockPlan).not.toHaveBeenCalled();
    // Executor should still run
    expect(mocks.mockExecute).toHaveBeenCalledOnce();
  });

  it("makes only one attempt when planRetries is 0", async () => {
    mocks.mockPlan.mockImplementation(
      () => new Promise<PlanResult>(() => {}), // never resolves
    );

    const resultPromise = runDispatchPipeline(baseOpts({ planTimeout: 1, planRetries: 0 }), "/tmp/test");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledOnce();
    expect(mocks.mockExecute).not.toHaveBeenCalled();
  });

  it("uses default timeout (10 min) and retries (1) when not configured", async () => {
    mocks.mockPlan.mockImplementation(
      () => new Promise<PlanResult>(() => {}), // never resolves
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ planTimeout: undefined, planRetries: undefined }),
      "/tmp/test",
    );

    // Default is 10 minutes = 600_000ms; advance past two attempts
    await vi.advanceTimersByTimeAsync(600_000); // first attempt timeout
    await vi.advanceTimersByTimeAsync(600_000); // second attempt timeout
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(2); // 1 retry = 2 attempts
  });
});

describe("verbose mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      dispatchResult: { task: TASK_FIXTURE, success: true },
      elapsedMs: 100,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 100);
      }),
    );
  });

  afterEach(() => {
    log.verbose = false;
    vi.useRealTimers();
  });

  it("does not create TUI when log.verbose is true", async () => {
    log.verbose = true;

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(createTui).not.toHaveBeenCalled();
  });

  it("logs phase transitions inline when verbose", async () => {
    log.verbose = true;

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    // Phase progress should be logged inline via log.info or log.debug
    const infoCalls = vi.mocked(log.info).mock.calls.map(([msg]) => msg);
    const debugCalls = vi.mocked(log.debug).mock.calls.map(([msg]) => msg);
    const allMessages = [...infoCalls, ...debugCalls];

    // Expect at least some phase-related messages (discovering, parsing, booting, dispatching)
    expect(allMessages.some((msg) => /discover/i.test(msg))).toBe(true);
    expect(allMessages.some((msg) => /pars/i.test(msg))).toBe(true);
    expect(allMessages.some((msg) => /boot/i.test(msg))).toBe(true);
    expect(allMessages.some((msg) => /dispatch/i.test(msg))).toBe(true);
  });

  it("logs task progress inline when verbose", async () => {
    log.verbose = true;

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    const infoCalls = vi.mocked(log.info).mock.calls.map(([msg]) => msg);
    const debugCalls = vi.mocked(log.debug).mock.calls.map(([msg]) => msg);
    const successCalls = vi.mocked(log.success).mock.calls.map(([msg]) => msg);
    const allMessages = [...infoCalls, ...debugCalls, ...successCalls];

    // Expect task-related progress messages
    expect(allMessages.some((msg) => /task/i.test(msg) || /implement/i.test(msg))).toBe(true);
  });

  it("still creates TUI when log.verbose is false", async () => {
    log.verbose = false;

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(createTui).toHaveBeenCalled();
  });
});

// ─── dryRunMode ─────────────────────────────────────────────────────

describe("dryRunMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty summary when no source is configured", async () => {
    const result = await dryRunMode([], "/tmp/test", undefined);

    expect(result).toEqual({ total: 0, completed: 0, failed: 0, skipped: 0, results: [] });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining("No datasource"));
  });

  it("returns empty summary when no items found", async () => {
    const { fetchItemsById } = await import("../orchestrator/datasource-helpers.js");
    vi.mocked(fetchItemsById).mockResolvedValueOnce([]);

    const result = await dryRunMode(["999"], "/tmp/test", "md");

    expect(result).toEqual({ total: 0, completed: 0, failed: 0, skipped: 0, results: [] });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("No work items"));
  });

  it("returns skipped count when tasks are found", async () => {
    const result = await dryRunMode(["1"], "/tmp/test", "md");

    expect(result.skipped).toBe(result.total);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });
});

// ─── runDispatchPipeline edge cases ─────────────────────────────────

describe("runDispatchPipeline edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      dispatchResult: { task: TASK_FIXTURE, success: true },
      elapsedMs: 100,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 100);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty summary when no source configured", async () => {
    const result = await runDispatchPipeline(baseOpts({ source: undefined }), "/tmp/test");

    expect(result).toEqual({ total: 0, completed: 0, failed: 0, skipped: 0, results: [] });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining("No datasource"));
  });

  it("returns empty summary when no items found", async () => {
    const { fetchItemsById } = await import("../orchestrator/datasource-helpers.js");
    vi.mocked(fetchItemsById).mockResolvedValueOnce([]);

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ total: 0, completed: 0, failed: 0, skipped: 0, results: [] });
  });

  it("returns empty summary when no unchecked tasks found", async () => {
    const { parseTaskFile } = await import("../parser.js");
    vi.mocked(parseTaskFile).mockResolvedValueOnce({
      path: "/tmp/dispatch-test/1-test.md",
      tasks: [],
      content: "# No tasks",
    });

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ total: 0, completed: 0, failed: 0, skipped: 0, results: [] });
  });

  it("delegates to dryRunMode when dryRun is true", async () => {
    const result = await runDispatchPipeline(baseOpts({ dryRun: true }), "/tmp/test");

    expect(result.skipped).toBe(result.total);
    expect(result.completed).toBe(0);
  });

  it("exercises branch lifecycle when noBranch is false", async () => {
    mocks.mockPlan.mockImplementation(() =>
      new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 50);
      }),
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
  });

  it("handles executor failure", async () => {
    mocks.mockExecute.mockResolvedValue({
      success: false,
      dispatchResult: { task: TASK_FIXTURE, success: false, error: "exec error" },
      elapsedMs: 50,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Plan", success: true }), 50);
      }),
    );

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
  });
});
