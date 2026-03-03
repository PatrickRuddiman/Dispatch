import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskFile } from "../parser.js";
import type { PlanResult, PlannerAgent } from "../agents/planner.js";
import type { ProviderInstance } from "../providers/interface.js";
import type { Datasource, IssueDetails } from "../datasources/interface.js";

// ─── Hoisted mock references and fixtures ───────────────────────────

const { mocks, TASK_FIXTURE, TASK_FILE_FIXTURE, TASK_FIXTURE_2, TASK_FILE_FIXTURE_2 } = vi.hoisted(() => {
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

  const TASK_FIXTURE_2: Task = {
    index: 0,
    text: "Fix the bug",
    line: 3,
    raw: "- [ ] Fix the bug",
    file: "/tmp/dispatch-test/2-bugfix.md",
  };

  const TASK_FILE_FIXTURE_2: TaskFile = {
    path: "/tmp/dispatch-test/2-bugfix.md",
    tasks: [TASK_FIXTURE_2],
    content: "# Bugfix\n\n- [ ] Fix the bug",
  };

  const mockPlan = vi.fn<PlannerAgent["plan"]>();
  const mockExecute = vi.fn();
  const mockGenerate = vi.fn();
  const mockCreateSession = vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("sess-1");
  const mockPrompt = vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done");
  const mockCleanup = vi.fn().mockResolvedValue(undefined);

  return {
    mocks: { mockPlan, mockExecute, mockGenerate, mockCreateSession, mockPrompt, mockCleanup },
    TASK_FIXTURE,
    TASK_FILE_FIXTURE,
    TASK_FIXTURE_2,
    TASK_FILE_FIXTURE_2,
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

vi.mock("../agents/commit.js", () => ({
  boot: vi.fn().mockResolvedValue({
    name: "commit",
    generate: mocks.mockGenerate,
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
    getUsername: vi.fn().mockResolvedValue("testuser"),
    buildBranchName: vi.fn().mockReturnValue("testuser/dispatch/1-test"),
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

vi.mock("../helpers/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue("/tmp/test/.dispatch/worktrees/1-test"),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  worktreeName: vi.fn().mockReturnValue("1-test"),
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
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
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
  buildPrBody: vi.fn().mockResolvedValue("PR body"),
  buildPrTitle: vi.fn().mockResolvedValue("PR title"),
  getBranchDiff: vi.fn().mockResolvedValue("diff --git a/file.ts b/file.ts\n+added line"),
  squashBranchCommits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("- [x] Implement the feature"),
}));

// ─── Import function under test (after mocks) ──────────────────────

import { runDispatchPipeline, dryRunMode } from "../orchestrator/dispatch-pipeline.js";
import { getDatasource } from "../datasources/index.js";
import { log } from "../helpers/logger.js";
import { createTui } from "../tui.js";
import { createWorktree, removeWorktree, worktreeName } from "../helpers/worktree.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { parseTaskFile } from "../parser.js";
import { fetchItemsById, writeItemsToTempDir, parseIssueFilename, getBranchDiff, squashBranchCommits } from "../orchestrator/datasource-helpers.js";

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
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "",
      prTitle: "",
      prDescription: "",
      success: false,
      error: "mock: not configured",
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
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "",
      prTitle: "",
      prDescription: "",
      success: false,
      error: "mock: not configured",
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
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "",
      prTitle: "",
      prDescription: "",
      success: false,
      error: "mock: not configured",
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

describe("commitAllChanges safety-net", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      dispatchResult: { task: TASK_FIXTURE, success: true },
      elapsedMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "",
      prTitle: "",
      prDescription: "",
      success: false,
      error: "mock: not configured",
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<PlanResult>((resolve) => {
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 50);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls commitAllChanges after task execution when branching is enabled", async () => {
    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.commitAllChanges).toHaveBeenCalledOnce();
  });

  it("does not call commitAllChanges when branching is disabled", async () => {
    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: true }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.commitAllChanges).not.toHaveBeenCalled();
  });

  it("continues gracefully if commitAllChanges throws", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.commitAllChanges).mockRejectedValueOnce(new Error("git add failed"));

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(ds.commitAllChanges).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("commit"),
    );
  });
});

describe("commit agent integration", () => {
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
        setTimeout(() => resolve({ prompt: "Execute step 1", success: true }), 50);
      }),
    );
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "",
      prTitle: "",
      prDescription: "",
      success: false,
      error: "mock: not configured",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses commit agent output for PR title and body when successful", async () => {
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "feat: add new feature",
      prTitle: "feat: add new feature for issue",
      prDescription: "This PR adds a new feature",
      success: true,
    });

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(mocks.mockGenerate).toHaveBeenCalledOnce();

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.createPullRequest).toHaveBeenCalledWith(
      expect.any(String),
      "1",
      "feat: add new feature for issue",
      "This PR adds a new feature",
      expect.any(Object),
    );
  });

  it("falls back to buildPrTitle/buildPrBody when commit agent fails", async () => {
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "",
      prTitle: "",
      prDescription: "",
      success: false,
      error: "provider error",
    });

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.createPullRequest).toHaveBeenCalledWith(
      expect.any(String),
      "1",
      "PR title",
      "PR body",
      expect.any(Object),
    );
  });

  it("squashes commits when commit agent provides a commit message", async () => {
    mocks.mockGenerate.mockResolvedValue({
      commitMessage: "feat: implement the feature",
      prTitle: "feat: implement the feature",
      prDescription: "Description",
      success: true,
    });

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(vi.mocked(squashBranchCommits)).toHaveBeenCalledWith(
      "main",
      "feat: implement the feature",
      expect.any(String),
    );
  });

  it("continues gracefully when commit agent throws", async () => {
    mocks.mockGenerate.mockRejectedValue(new Error("agent crashed"));

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Commit agent error"),
    );

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.createPullRequest).toHaveBeenCalledWith(
      expect.any(String),
      "1",
      "PR title",
      "PR body",
      expect.any(Object),
    );
  });

  it("skips commit agent when branch diff is empty", async () => {
    vi.mocked(getBranchDiff).mockResolvedValue("");

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(mocks.mockGenerate).not.toHaveBeenCalled();
  });

  it("does not invoke commit agent when branching is disabled", async () => {
    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: true }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(mocks.mockGenerate).not.toHaveBeenCalled();
  });
});

// ─── Worktree dispatch pipeline ─────────────────────────────────

const ISSUE_1: IssueDetails = {
  number: "1",
  title: "Test",
  body: "# Test\n\n- [ ] Implement the feature",
  labels: [],
  state: "open",
  url: "https://example.com/1",
  comments: [],
  acceptanceCriteria: "",
};

const ISSUE_2: IssueDetails = {
  number: "2",
  title: "Bugfix",
  body: "# Bugfix\n\n- [ ] Fix the bug",
  labels: [],
  state: "open",
  url: "https://example.com/2",
  comments: [],
  acceptanceCriteria: "",
};

function multiIssueOpts(overrides?: Partial<Parameters<typeof runDispatchPipeline>[0]>) {
  return baseOpts({
    issueIds: ["1", "2"],
    noBranch: false,
    noPlan: true,
    ...overrides,
  });
}

function setupMultiIssueScenario() {
  vi.mocked(fetchItemsById).mockResolvedValue([ISSUE_1, ISSUE_2]);
  vi.mocked(writeItemsToTempDir).mockResolvedValue({
    files: ["/tmp/dispatch-test/1-test.md", "/tmp/dispatch-test/2-bugfix.md"],
    issueDetailsByFile: new Map([
      ["/tmp/dispatch-test/1-test.md", ISSUE_1],
      ["/tmp/dispatch-test/2-bugfix.md", ISSUE_2],
    ]),
  });

  vi.mocked(parseTaskFile).mockImplementation(async (file: string) => {
    if (file.includes("2-bugfix")) return TASK_FILE_FIXTURE_2;
    return TASK_FILE_FIXTURE;
  });

  vi.mocked(parseIssueFilename).mockImplementation((file: string) => {
    if (file.includes("2-bugfix")) return { issueId: "2", slug: "bugfix" };
    return { issueId: "1", slug: "test" };
  });

  vi.mocked(createWorktree).mockImplementation(async (_root: string, file: string) => {
    if (file.includes("2-bugfix")) return "/tmp/test/.dispatch/worktrees/2-bugfix";
    return "/tmp/test/.dispatch/worktrees/1-test";
  });

  vi.mocked(worktreeName).mockImplementation((file: string) => {
    if (file.includes("2-bugfix")) return "2-bugfix";
    return "1-test";
  });

  const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
  vi.mocked(ds.buildBranchName).mockImplementation((num: string, title: string, user?: string) => {
    return `${user}/dispatch/${num}-${title.toLowerCase().replace(/\s+/g, "-")}`;
  });
}

describe("worktree dispatch pipeline", () => {
  describe("multi-issue worktree mode", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.mockExecute.mockImplementation(async ({ task }: any) => ({
        success: true,
        dispatchResult: { task, success: true },
        elapsedMs: 100,
      }));
      mocks.mockGenerate.mockResolvedValue({
        commitMessage: "",
        prTitle: "",
        prDescription: "",
        success: false,
        error: "mock: not configured",
      });
      setupMultiIssueScenario();
    });

    it("creates a worktree for each issue file", async () => {
      const result = await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      expect(result.completed).toBe(2);
      expect(vi.mocked(createWorktree)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createWorktree)).toHaveBeenCalledWith(
        "/tmp/test",
        "/tmp/dispatch-test/1-test.md",
        expect.stringContaining("1"),
      );
      expect(vi.mocked(createWorktree)).toHaveBeenCalledWith(
        "/tmp/test",
        "/tmp/dispatch-test/2-bugfix.md",
        expect.stringContaining("2"),
      );
    });

    it("passes worktree path as cwd to executor", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      const executeCalls = mocks.mockExecute.mock.calls;
      const cwds = executeCalls.map((call: any[]) => call[0].cwd);

      expect(cwds).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(cwds).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("calls removeWorktree for each issue after completion", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      expect(vi.mocked(removeWorktree)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith("/tmp/test", "/tmp/dispatch-test/1-test.md");
      expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith("/tmp/test", "/tmp/dispatch-test/2-bugfix.md");
    });

    it("registers cleanup handlers for worktrees", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      // registerCleanup called for: provider instance + 2 worktrees = 3
      expect(vi.mocked(registerCleanup)).toHaveBeenCalledTimes(3);
    });

    it("tags TUI tasks with worktree name", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      const tuiState = vi.mocked(createTui).mock.results[0].value.state;
      const worktreeNames = tuiState.tasks.map((t: any) => t.worktree);

      expect(worktreeNames).toContain("1-test");
      expect(worktreeNames).toContain("2-bugfix");
    });

    it("does not call switchBranch or createAndSwitchBranch in worktree mode", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
      expect(ds.createAndSwitchBranch).not.toHaveBeenCalled();
      expect(ds.switchBranch).not.toHaveBeenCalled();
    });

    it("passes worktree cwd to commitAllChanges", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
      const commitCalls = vi.mocked(ds.commitAllChanges).mock.calls;
      const commitCwds = commitCalls.map((call: any[]) => call[1]?.cwd);

      expect(commitCwds).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(commitCwds).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("continues without branching when worktree creation fails", async () => {
      vi.mocked(createWorktree).mockRejectedValue(new Error("worktree creation failed"));

      const result = await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      expect(result.completed).toBe(2);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Could not create branch"),
      );
    });
  });

  describe("serial fallback", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Restore single-issue defaults overridden by setupMultiIssueScenario()
      vi.mocked(fetchItemsById).mockResolvedValue([ISSUE_1]);
      vi.mocked(writeItemsToTempDir).mockResolvedValue({
        files: ["/tmp/dispatch-test/1-test.md"],
        issueDetailsByFile: new Map([["/tmp/dispatch-test/1-test.md", ISSUE_1]]),
      });
      vi.mocked(parseTaskFile).mockResolvedValue(TASK_FILE_FIXTURE);
      vi.mocked(parseIssueFilename).mockReturnValue({ issueId: "1", slug: "test" });
      mocks.mockExecute.mockResolvedValue({
        success: true,
        dispatchResult: { task: TASK_FIXTURE, success: true },
        elapsedMs: 100,
      });
      mocks.mockGenerate.mockResolvedValue({
        commitMessage: "",
        prTitle: "",
        prDescription: "",
        success: false,
        error: "mock: not configured",
      });
    });

    it("uses serial mode for single-issue runs even without --no-worktree", async () => {
      const result = await runDispatchPipeline(
        baseOpts({ noBranch: false, noPlan: true }),
        "/tmp/test",
      );

      expect(result.completed).toBe(1);
      expect(vi.mocked(createWorktree)).not.toHaveBeenCalled();

      const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
      expect(ds.createAndSwitchBranch).toHaveBeenCalledOnce();
    });

    it("falls back to serial branch mode with --no-worktree", async () => {
      setupMultiIssueScenario();
      mocks.mockExecute.mockImplementation(async ({ task }: any) => ({
        success: true,
        dispatchResult: { task, success: true },
        elapsedMs: 100,
      }));

      const result = await runDispatchPipeline(
        multiIssueOpts({ noWorktree: true }),
        "/tmp/test",
      );

      expect(result.completed).toBe(2);
      expect(vi.mocked(createWorktree)).not.toHaveBeenCalled();

      const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
      expect(ds.createAndSwitchBranch).toHaveBeenCalledTimes(2);
      expect(ds.switchBranch).toHaveBeenCalledTimes(2);
    });
  });
});


