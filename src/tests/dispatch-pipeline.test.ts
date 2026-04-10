import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskFile } from "../parser.js";
import type { Skill } from "../skills/interface.js";
import type { SkillResult, PlannerData } from "../skills/types.js";
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

  const mockPlan = vi.fn();
  const mockExecute = vi.fn();
  const mockGenerate = vi.fn();
  const mockDispatch = vi.fn();
  const mockCreateSession = vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("sess-1");
  const mockPrompt = vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done");
  const mockCleanup = vi.fn().mockResolvedValue(undefined);
  const mockGlob = vi.fn();

  return {
    mocks: { mockPlan, mockExecute, mockGenerate, mockDispatch, mockCreateSession, mockPrompt, mockCleanup, mockGlob },
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
  getAuthenticatedProviders: vi.fn().mockResolvedValue(["opencode"]),
  checkProviderAuthenticated: vi.fn().mockResolvedValue(true),
  getProviderAuthStatus: vi.fn().mockResolvedValue({ status: "authenticated" }),
  PROVIDER_NAMES: ["opencode", "copilot", "claude", "codex"],
}));

vi.mock("../providers/router.js", () => ({
  routeAllSkills: vi.fn().mockReturnValue({
    planner: [{ provider: "opencode", model: "claude-haiku-4", priority: 0 }],
    executor: [{ provider: "opencode", model: "claude-sonnet-4-5", priority: 0 }],
    commit: [{ provider: "opencode", model: "claude-haiku-4", priority: 0 }],
  }),
  routeSkill: vi.fn().mockReturnValue([{ provider: "opencode", model: "claude-sonnet-4-5", priority: 0 }]),
}));

vi.mock("../skills/planner.js", () => ({
  plannerSkill: { name: "planner", buildPrompt: vi.fn(), parseResult: vi.fn() },
}));

vi.mock("../skills/executor.js", () => ({
  executorSkill: { name: "executor", buildPrompt: vi.fn(), parseResult: vi.fn() },
}));

vi.mock("../skills/commit.js", () => ({
  commitSkill: { name: "commit", buildPrompt: vi.fn(), parseResult: vi.fn() },
}));

vi.mock("../dispatcher.js", () => ({
  dispatch: mocks.mockDispatch,
}));

vi.mock("../datasources/index.js", () => ({
  getDatasource: vi.fn().mockReturnValue({
    name: "md",
    supportsGit: vi.fn().mockReturnValue(true),
    list: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockResolvedValue({} as IssueDetails),
    update: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({} as IssueDetails),
    getDefaultBranch: vi.fn().mockResolvedValue("main"),
    getCurrentBranch: vi.fn().mockResolvedValue("main"),
    getUsername: vi.fn().mockResolvedValue("testuser"),
    buildBranchName: vi.fn().mockReturnValue("testuser/dispatch/1"),
    createAndSwitchBranch: vi.fn().mockResolvedValue(undefined),
    switchBranch: vi.fn().mockResolvedValue(undefined),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    commitAllChanges: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue("https://example.com/pr/1"),
  } satisfies Datasource),
  getGitRemoteUrl: vi.fn().mockResolvedValue(null),
  parseAzDevOpsRemoteUrl: vi.fn().mockReturnValue(null),
  parseGitHubRemoteUrl: vi.fn().mockReturnValue(null),
}));

vi.mock("../helpers/auth.js", () => ({
  getGithubOctokit: vi.fn().mockResolvedValue({}),
  getAzureConnection: vi.fn().mockResolvedValue({}),
  setAuthPromptHandler: vi.fn(),
  ensureAuthReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tui.js", () => ({
  createTui: vi.fn().mockImplementation(() => ({
    state: {
      tasks: [],
      phase: "discovering",
      startTime: Date.now(),
      filesFound: 0,
    },
    update: vi.fn(),
    stop: vi.fn(),
    waitForRecoveryAction: vi.fn().mockResolvedValue("quit"),
  })),
}));

vi.mock("../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../helpers/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue("/tmp/test/.dispatch/worktrees/1-test"),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  worktreeName: vi.fn().mockReturnValue("1-test"),
  generateFeatureBranchName: vi.fn().mockReturnValue("dispatch/feature-abcd1234"),
}));

vi.mock("../helpers/branch-validation.js", () => ({
  isValidBranchName: vi.fn().mockReturnValue(true),
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
  markTaskComplete: vi.fn().mockResolvedValue(undefined),
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
  parseIssueFilename: vi.fn().mockReturnValue({ issueId: "1", slug: "test" }),
  buildPrBody: vi.fn().mockResolvedValue("PR body"),
  buildPrTitle: vi.fn().mockResolvedValue("PR title"),
  getBranchDiff: vi.fn().mockResolvedValue("diff --git a/file.ts b/file.ts\n+added line"),
  squashBranchCommits: vi.fn().mockResolvedValue(undefined),
  buildFeaturePrTitle: vi.fn().mockReturnValue("feat: dispatch/feature-abcd1234 (#1, #2)"),
  buildFeaturePrBody: vi.fn().mockReturnValue("Feature PR body"),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("- [x] Implement the feature"),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      cb(null, "", "");
    }
  }),
}));

vi.mock("glob", () => ({
  glob: mocks.mockGlob,
}));

// ─── Import function under test (after mocks) ──────────────────────

import { runDispatchPipeline, dryRunMode } from "../orchestrator/dispatch-pipeline.js";
import { getDatasource } from "../datasources/index.js";
import { getGithubOctokit, getAzureConnection, setAuthPromptHandler } from "../helpers/auth.js";
import { log } from "../helpers/logger.js";
import { createTui } from "../tui.js";
import { createWorktree, removeWorktree, worktreeName, generateFeatureBranchName } from "../helpers/worktree.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { parseTaskFile } from "../parser.js";
import { fetchItemsById, writeItemsToTempDir, parseIssueFilename, getBranchDiff, squashBranchCommits, buildFeaturePrTitle, buildFeaturePrBody } from "../orchestrator/datasource-helpers.js";
import { execFile } from "node:child_process";
import { bootProvider } from "../providers/index.js";
import { isValidBranchName } from "../helpers/branch-validation.js";
import { glob } from "glob";
import { readFile } from "node:fs/promises";

// ─── Helpers ────────────────────────────────────────────────────────

const githubAuthMock = {} as Awaited<ReturnType<typeof getGithubOctokit>>;
const azureAuthMock = {} as Awaited<ReturnType<typeof getAzureConnection>>;

function resetAuthMocks() {
  vi.mocked(getGithubOctokit).mockResolvedValue(githubAuthMock);
  vi.mocked(getAzureConnection).mockResolvedValue(azureAuthMock);
}

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

function getMockTui() {
  return vi.mocked(createTui).mock.results[0]?.value;
}

/**
 * Set up the default mockDispatch routing.
 * Called in each describe's beforeEach to ensure consistent behavior.
 */
function setupMockDispatch() {
  mocks.mockDispatch.mockImplementation(async (skill: Skill<any, any>, input: any) => {
    if (skill.name === "planner") {
      return mocks.mockPlan(input);
    }
    if (skill.name === "executor") {
      return mocks.mockExecute(input);
    }
    if (skill.name === "commit") {
      return mocks.mockGenerate(input);
    }
    throw new Error(`Unknown skill: ${skill.name}`);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("planning timeout and retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    // Reset the executor mock to default success
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds when planning completes within the timeout", async () => {
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 }), 100);
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
        return new Promise<SkillResult<PlannerData>>((resolve) => {
          setTimeout(() => resolve({ data: { prompt: "too late" }, success: true, durationMs: 120000 }), 120_000);
        });
      }
      // Second attempt: succeeds quickly
      return new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 }), 100);
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
      () => new Promise<SkillResult<PlannerData>>(() => {}), // never resolves
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

  it("does not retry on non-timeout errors and fails immediately", async () => {
    mocks.mockPlan.mockRejectedValue(new Error("Provider connection refused"));

    const resultPromise = runDispatchPipeline(baseOpts({ planRetries: 2 }), "/tmp/test");
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    // Non-timeout errors are not retried — only one attempt
    expect(mocks.mockPlan).toHaveBeenCalledTimes(1);
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
      () => new Promise<SkillResult<PlannerData>>(() => {}), // never resolves
    );

    const resultPromise = runDispatchPipeline(baseOpts({ planTimeout: 1, planRetries: 0 }), "/tmp/test");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledOnce();
    expect(mocks.mockExecute).not.toHaveBeenCalled();
  });

  it("uses default timeout (15 min) and shared retries (3) when not configured", async () => {
    mocks.mockPlan.mockImplementation(
      () => new Promise<SkillResult<PlannerData>>(() => {}), // never resolves
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ planTimeout: undefined, planRetries: undefined }),
      "/tmp/test",
    );

    // Default is 30 minutes = 1_800_000ms; advance past four attempts (default retries=3)
    await vi.advanceTimersByTimeAsync(1_800_000); // first attempt timeout
    await vi.advanceTimersByTimeAsync(1_800_000); // second attempt timeout
    await vi.advanceTimersByTimeAsync(1_800_000); // third attempt timeout
    await vi.advanceTimersByTimeAsync(1_800_000); // fourth attempt timeout
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(4); // 3 retries = 4 attempts
  });

  it("falls back to general retries when planRetries is not set", async () => {
    mocks.mockPlan.mockImplementation(
      () => new Promise<SkillResult<PlannerData>>(() => {}), // never resolves
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ planTimeout: 1, planRetries: undefined, retries: 1 }),
      "/tmp/test",
    );

    // retries=1 → 2 total attempts at 1 min each
    await vi.advanceTimersByTimeAsync(60_000); // first attempt timeout
    await vi.advanceTimersByTimeAsync(60_000); // second attempt timeout
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(2); // 1 retry = 2 attempts
  });

  it("prefers planRetries over general retries for planning timeouts", async () => {
    mocks.mockPlan.mockImplementation(
      () => new Promise<SkillResult<PlannerData>>(() => {}),
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ planTimeout: 1, planRetries: 1, retries: 3 }),
      "/tmp/test",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on non-timeout error without retrying", async () => {
    mocks.mockPlan.mockImplementation(() => {
      return Promise.reject(new Error("Transient API failure"));
    });

    const resultPromise = runDispatchPipeline(baseOpts({ planRetries: 1 }), "/tmp/test");
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    // Non-timeout errors break immediately — only one attempt
    expect(mocks.mockPlan).toHaveBeenCalledTimes(1);
    expect(mocks.mockExecute).not.toHaveBeenCalled();
  });
});

describe("verbose mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 }), 100);
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

  it("fails predictably without recovery input when verbose mode exhausts retries", async () => {
    log.verbose = true;
    mocks.mockExecute.mockResolvedValue({
      success: false,
      data: { dispatchResult: { task: TASK_FIXTURE, success: false, error: "persistent error" } },
      error: "persistent error",
      durationMs: 50,
    });

    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(createTui).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("will not wait for input"));
  });
});

// ─── dryRunMode ─────────────────────────────────────────────────────

describe("dryRunMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
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
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 }), 100);
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
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 50 }), 50);
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
      data: null,
      error: "exec error",
      durationMs: 50,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Plan" }, success: true, durationMs: 50 }), 50);
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
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 50 }), 50);
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

describe("branch creation failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks all tasks as failed when createAndSwitchBranch rejects", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockRejectedValueOnce(
      new Error("branch already exists"),
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false, noPlan: true }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("branch"),
    );
  });

  it("does not invoke executor when branch creation fails", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockRejectedValueOnce(
      new Error("branch already exists"),
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false, noPlan: true }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(mocks.mockExecute).not.toHaveBeenCalled();
  });

  it("succeeds when noBranch is true even if createAndSwitchBranch would throw", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockRejectedValueOnce(
      new Error("should not be called"),
    );

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: true, noPlan: true }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(ds.createAndSwitchBranch).not.toHaveBeenCalled();
  });
});

describe("supportsGit() guard behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    // Reset createAndSwitchBranch to clear any leftover mockRejectedValueOnce
    // from "branch creation failure" tests (clearAllMocks does not flush the once-queue).
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockReset().mockResolvedValue(undefined);
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 50 }), 50);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips git lifecycle calls when supportsGit() returns false", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.supportsGit).mockReturnValue(false);

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(ds.createAndSwitchBranch).not.toHaveBeenCalled();
    expect(ds.switchBranch).not.toHaveBeenCalled();
    expect(ds.pushBranch).not.toHaveBeenCalled();
    expect(ds.createPullRequest).not.toHaveBeenCalled();
  });

  it("calls git lifecycle methods when supportsGit() returns true", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.supportsGit).mockReturnValue(true);

    const resultPromise = runDispatchPipeline(
      baseOpts({ noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(ds.createAndSwitchBranch).toHaveBeenCalled();
    expect(ds.pushBranch).toHaveBeenCalled();
    expect(ds.createPullRequest).toHaveBeenCalled();
  });
});

describe("commit skill integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    // Reset createAndSwitchBranch to clear any leftover mockRejectedValueOnce
    // from "branch creation failure" tests (clearAllMocks does not flush the once-queue).
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockReset().mockResolvedValue(undefined);
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 50 }), 50);
      }),
    );
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses commit skill output for PR title and body when successful", async () => {
    mocks.mockGenerate.mockResolvedValue({
      data: { commitMessage: "feat: add new feature", prTitle: "feat: add new feature for issue", prDescription: "This PR adds a new feature" },
      success: true,
      durationMs: 100,
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
      "main",
    );
  });

  it("falls back to buildPrTitle/buildPrBody when commit skill fails", async () => {
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "provider error",
      durationMs: 0,
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
      "main",
    );
  });

  it("squashes commits when commit skill provides a commit message", async () => {
    mocks.mockGenerate.mockResolvedValue({
      data: { commitMessage: "feat: implement the feature", prTitle: "feat: implement the feature", prDescription: "Description" },
      success: true,
      durationMs: 100,
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

  it("continues gracefully when commit skill throws", async () => {
    mocks.mockGenerate.mockRejectedValue(new Error("skill crashed"));

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
      "main",
    );
  });

  it("skips commit skill when branch diff is empty", async () => {
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

  it("does not invoke commit skill when branching is disabled", async () => {
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
  vi.mocked(ds.buildBranchName).mockImplementation((num: string, _title: string, user?: string) => {
    return `${user}/dispatch/issue-${num}`;
  });
}

describe("worktree dispatch pipeline", () => {
  describe("multi-issue worktree mode", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    setupMockDispatch();
      resetAuthMocks();
      mocks.mockExecute.mockImplementation(async ({ task }: any) => ({
        success: true,
        data: { dispatchResult: { task, success: true } },
        durationMs: 100,
      }));
      mocks.mockGenerate.mockResolvedValue({
        data: null,
        success: false,
        error: "mock: not configured",
        durationMs: 0,
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

      // registerCleanup called for: per-worktree pools (3 per worktree × 2) + 2 worktrees = 8
      expect(vi.mocked(registerCleanup).mock.calls.length).toBeGreaterThanOrEqual(4);
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

    it("fails tasks when worktree creation fails", async () => {
      vi.mocked(createWorktree).mockRejectedValue(new Error("worktree creation failed"));

      const result = await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      expect(result.failed).toBe(2);
      expect(result.completed).toBe(0);
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining("Branch creation failed"),
      );
    });

    it("dispatches executor with correct cwd for each worktree", async () => {
      await runDispatchPipeline(multiIssueOpts(), "/tmp/test");

      // Each worktree gets dispatch calls targeting the correct cwd
      const executeCalls = mocks.mockExecute.mock.calls;
      const cwds = executeCalls.map((call: any[]) => call[0].cwd);
      expect(cwds).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(cwds).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("dispatches per-worktree planner and executor skills", async () => {
      await runDispatchPipeline(multiIssueOpts({ noPlan: false }), "/tmp/test");

      // 2 planners, 2 executors (one per worktree)
      expect(mocks.mockPlan).toHaveBeenCalledTimes(2);
      expect(mocks.mockExecute).toHaveBeenCalledTimes(2);

      const planCwds = mocks.mockPlan.mock.calls.map((call: any[]) => call[0].cwd);
      expect(planCwds).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(planCwds).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");

      const execCwds = mocks.mockExecute.mock.calls.map((call: any[]) => call[0].cwd);
      expect(execCwds).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(execCwds).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("passes issueCwd to planner.plan() call", async () => {
      mocks.mockPlan.mockResolvedValue({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 });

      await runDispatchPipeline(multiIssueOpts({ noPlan: false }), "/tmp/test");

      // Verify plan() was called with the worktree cwd
      const planCalls = mocks.mockPlan.mock.calls;
      const planCwds = planCalls.map((call: any[]) => call[0].cwd);

      expect(planCwds).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(planCwds).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("passes worktreeRoot to planner.plan() call in worktree mode", async () => {
      mocks.mockPlan.mockResolvedValue({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 });

      await runDispatchPipeline(multiIssueOpts({ noPlan: false }), "/tmp/test");

      // Verify plan() was called with worktreeRoot
      const planCalls = mocks.mockPlan.mock.calls;
      const planWorktreeRoots = planCalls.map((call: any[]) => call[0].worktreeRoot);

      expect(planWorktreeRoots).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(planWorktreeRoots).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("passes worktreeRoot to executor.execute() in worktree mode", async () => {
      await runDispatchPipeline(multiIssueOpts({ noPlan: true }), "/tmp/test");

      const executeCalls = mocks.mockExecute.mock.calls;
      const worktreeRoots = executeCalls.map((call: any[]) => call[0].worktreeRoot);

      expect(worktreeRoots).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(worktreeRoots).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });

    it("passes worktreeRoot to commitSkill.generate() in worktree mode", async () => {
      vi.mocked(getBranchDiff).mockResolvedValue("diff --git a/file.ts b/file.ts\n+added line");
      mocks.mockGenerate.mockResolvedValue({
        data: { commitMessage: "feat: test", prTitle: "feat: test", prDescription: "description" },
        success: true,
        durationMs: 100,
      });

      await runDispatchPipeline(multiIssueOpts({ noPlan: true }), "/tmp/test");

      const generateCalls = mocks.mockGenerate.mock.calls;
      const worktreeRoots = generateCalls.map((call: any[]) => call[0].worktreeRoot);

      expect(worktreeRoots).toContain("/tmp/test/.dispatch/worktrees/1-test");
      expect(worktreeRoots).toContain("/tmp/test/.dispatch/worktrees/2-bugfix");
    });
  });

  describe("serial fallback", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    setupMockDispatch();
      resetAuthMocks();
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
        data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
        durationMs: 100,
      });
      // Reset datasource branch mocks to prevent leftover rejections from earlier tests
      const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
      vi.mocked(ds.createAndSwitchBranch).mockReset().mockResolvedValue(undefined);
      vi.mocked(ds.switchBranch).mockReset().mockResolvedValue(undefined);
      mocks.mockGenerate.mockResolvedValue({
        data: null,
        success: false,
        error: "mock: not configured",
        durationMs: 0,
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
        data: { dispatchResult: { task, success: true } },
        durationMs: 100,
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

    it("does not pass worktreeRoot when --no-worktree is set", async () => {
      setupMultiIssueScenario();
      vi.mocked(getBranchDiff).mockResolvedValue("diff --git a/file.ts b/file.ts\n+added line");
      mocks.mockExecute.mockImplementation(async ({ task }: any) => ({
        success: true,
        data: { dispatchResult: { task, success: true } },
        durationMs: 100,
      }));
      mocks.mockGenerate.mockResolvedValue({
        data: { commitMessage: "feat: test", prTitle: "feat: test", prDescription: "description" },
        success: true,
        durationMs: 100,
      });

      await runDispatchPipeline(
        multiIssueOpts({ noWorktree: true }),
        "/tmp/test",
      );

      // With --no-worktree, worktreeRoot should be undefined for all skills
      const executeCalls = mocks.mockExecute.mock.calls;
      for (const call of executeCalls) {
        expect(call[0].worktreeRoot).toBeUndefined();
      }

      const generateCalls = mocks.mockGenerate.mock.calls;
      for (const call of generateCalls) {
        expect(call[0].worktreeRoot).toBeUndefined();
      }
    });

    it("boots skills with shared pools when useWorktrees is false", async () => {
      await runDispatchPipeline(
        baseOpts({ noBranch: false, noPlan: true }),
        "/tmp/test",
      );

      // Executor dispatch is called with the correct cwd
      const executeCalls = mocks.mockExecute.mock.calls;
      expect(executeCalls[0][0].cwd).toBe("/tmp/test");
    });

    it("dispatches planner and executor with correct cwd in serial mode", async () => {
      mocks.mockPlan.mockResolvedValue({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 });

      await runDispatchPipeline(
        baseOpts({ noBranch: false, noPlan: false }),
        "/tmp/test",
      );

      expect(mocks.mockPlan).toHaveBeenCalledTimes(1);
      expect(mocks.mockExecute).toHaveBeenCalledTimes(1);

      expect(mocks.mockPlan.mock.calls[0][0].cwd).toBe("/tmp/test");
    });

    it("does not pass worktreeRoot in serial mode", async () => {
      mocks.mockPlan.mockResolvedValue({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 });
      vi.mocked(getBranchDiff).mockResolvedValue("diff --git a/file.ts b/file.ts\n+added line");
      mocks.mockGenerate.mockResolvedValue({
        data: { commitMessage: "feat: test", prTitle: "feat: test", prDescription: "description" },
        success: true,
        durationMs: 100,
      });

      await runDispatchPipeline(
        baseOpts({ noBranch: false, noPlan: false }),
        "/tmp/test",
      );

      // In serial mode, worktreeRoot should be undefined
      const planCalls = mocks.mockPlan.mock.calls;
      expect(planCalls[0][0].worktreeRoot).toBeUndefined();

      const executeCalls = mocks.mockExecute.mock.calls;
      expect(executeCalls[0][0].worktreeRoot).toBeUndefined();

      const generateCalls = mocks.mockGenerate.mock.calls;
      expect(generateCalls[0][0].worktreeRoot).toBeUndefined();
    });
  });

  // ─── Executor retry ─────────────────────────────────────────────────

  describe("executor retry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.clearAllMocks();
    setupMockDispatch();
      resetAuthMocks();
      // Restore single-issue defaults (may have been overridden by setupMultiIssueScenario)
      vi.mocked(fetchItemsById).mockResolvedValue([ISSUE_1]);
      vi.mocked(writeItemsToTempDir).mockResolvedValue({
        files: ["/tmp/dispatch-test/1-test.md"],
        issueDetailsByFile: new Map([["/tmp/dispatch-test/1-test.md", ISSUE_1]]),
      });
      vi.mocked(parseTaskFile).mockResolvedValue(TASK_FILE_FIXTURE);
      vi.mocked(parseIssueFilename).mockReturnValue({ issueId: "1", slug: "test" });
      mocks.mockPlan.mockImplementation(() =>
        new Promise<SkillResult<PlannerData>>((resolve) => {
          setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 }), 100);
        }),
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries executor on failure and succeeds on retry", async () => {
      let callCount = 0;
      mocks.mockExecute.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            data: { dispatchResult: { task: TASK_FIXTURE, success: false, error: "transient error" } },
            error: "transient error",
            durationMs: 50,
          };
        }
        return {
          success: true,
          data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
          durationMs: 100,
        };
      });

      const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(mocks.mockExecute).toHaveBeenCalledTimes(2);
    });

    it("fails the task when all executor attempts are exhausted", async () => {
      const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
      await vi.advanceTimersByTimeAsync(0); // flush ensureAuthReady microtask so createTui runs
      const tui = getMockTui();
      mocks.mockExecute.mockResolvedValue({
        success: false,
        data: { dispatchResult: { task: TASK_FIXTURE, success: false, error: "persistent error" } },
        error: "persistent error",
        durationMs: 50,
      });

      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
      // 3 retries + 1 initial = 4 total attempts
      expect(mocks.mockExecute).toHaveBeenCalledTimes(4);
      expect(tui.waitForRecoveryAction).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("will not wait for input"));
    });

    it("uses explicit general retries for executor attempts", async () => {
      mocks.mockExecute.mockResolvedValue({
        success: false,
        data: { dispatchResult: { task: TASK_FIXTURE, success: false, error: "persistent error" } },
        error: "persistent error",
        durationMs: 50,
      });

      const resultPromise = runDispatchPipeline(baseOpts({ retries: 1 }), "/tmp/test");
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
      expect(mocks.mockExecute).toHaveBeenCalledTimes(2);
    });

    it("does not retry when executor succeeds on first attempt", async () => {
      mocks.mockExecute.mockResolvedValue({
        success: true,
        data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
        durationMs: 100,
      });

      const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(mocks.mockExecute).toHaveBeenCalledOnce();
    });

    it("pauses exhausted executor failure and reruns successfully", async () => {
      const originalStdIn = process.stdin.isTTY;
      const originalStdOut = process.stdout.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

      let executeCalls = 0;
      mocks.mockExecute.mockImplementation(async () => {
        executeCalls++;
        if (executeCalls <= 4) {
          return {
            success: false,
            data: { dispatchResult: { task: TASK_FIXTURE, success: false, error: "persistent error" } },
            error: "persistent error",
            durationMs: 50,
          };
        }
        return {
          success: true,
          data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
          durationMs: 50,
        };
      });

      const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
      await vi.advanceTimersByTimeAsync(0); // flush ensureAuthReady microtask so createTui runs
      const tui = getMockTui();
      vi.mocked(tui.waitForRecoveryAction).mockImplementationOnce(async () => {
        expect(tui.state.recovery?.selectedAction).toBe("rerun");
        return "rerun";
      });
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(mocks.mockPlan).toHaveBeenCalledTimes(2);
      expect(mocks.mockExecute).toHaveBeenCalledTimes(5);
      expect(tui.waitForRecoveryAction).toHaveBeenCalledOnce();
      expect(tui.state.recovery).toBeUndefined();
      expect(tui.state.tasks[0].status).toBe("done");

      Object.defineProperty(process.stdin, "isTTY", { value: originalStdIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: originalStdOut, configurable: true });
    });

    it("captures paused recovery metadata before waiting for input", async () => {
      const originalStdIn = process.stdin.isTTY;
      const originalStdOut = process.stdout.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

      try {
        setupMultiIssueScenario();
        mocks.mockExecute.mockImplementation(async ({ task }: any) => {
          if (task.file.includes("1-test")) {
            return {
              success: false,
              data: { dispatchResult: { task, success: false, error: "persistent error" } },
              error: "persistent error",
              durationMs: 50,
            };
          }
          return {
            success: true,
            data: { dispatchResult: { task, success: true } },
            durationMs: 50,
          };
        });

        const resultPromise = runDispatchPipeline(multiIssueOpts(), "/tmp/test");
        await vi.advanceTimersByTimeAsync(0); // flush ensureAuthReady microtask so createTui runs
        const tui = getMockTui();
        vi.mocked(tui.waitForRecoveryAction).mockImplementationOnce(async () => {
          expect(tui.state.phase).toBe("paused");
          expect(tui.state.tasks[0].status).toBe("paused");
          expect(tui.state.recovery).toMatchObject({
            taskIndex: 0,
            taskText: "Implement the feature",
            error: "persistent error",
            selectedAction: "rerun",
            issue: { number: "1", title: "Test" },
            worktree: "1-test",
          });
          return "quit";
        });
        await vi.advanceTimersByTimeAsync(100);
        await vi.runAllTimersAsync();

        const result = await resultPromise;

        expect(result.completed).toBe(0);
        expect(result.failed).toBe(1);
        expect(tui.waitForRecoveryAction).toHaveBeenCalledOnce();
        expect(tui.state.recovery).toBeUndefined();
        expect(tui.state.tasks[0].status).toBe("failed");
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: originalStdIn, configurable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: originalStdOut, configurable: true });
      }
    });

    it("re-enters planning for each rerun and fails cleanly after repeated recovery", async () => {
      const originalStdIn = process.stdin.isTTY;
      const originalStdOut = process.stdout.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

      try {
        mocks.mockExecute.mockResolvedValue({
          success: false,
          data: { dispatchResult: { task: TASK_FIXTURE, success: false, error: "persistent error" } },
          error: "persistent error",
          durationMs: 50,
        });

        const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
        await vi.advanceTimersByTimeAsync(0); // flush ensureAuthReady microtask so createTui runs
        const tui = getMockTui();
        vi.mocked(tui.waitForRecoveryAction)
          .mockResolvedValueOnce("rerun")
          .mockResolvedValueOnce("rerun")
          .mockResolvedValueOnce("quit");

        await vi.advanceTimersByTimeAsync(100);
        await vi.runAllTimersAsync();

        const result = await resultPromise;

        expect(result.completed).toBe(0);
        expect(result.failed).toBe(1);
        expect(mocks.mockPlan).toHaveBeenCalledTimes(3);
        expect(mocks.mockExecute).toHaveBeenCalledTimes(12);
        expect(tui.waitForRecoveryAction).toHaveBeenCalledTimes(3);
        expect(tui.state.tasks[0].status).toBe("failed");
        expect(tui.state.recovery).toBeUndefined();
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: originalStdIn, configurable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: originalStdOut, configurable: true });
      }
    });

    it("quitting recovery stops remaining work and preserves context", async () => {
      const originalStdIn = process.stdin.isTTY;
      const originalStdOut = process.stdout.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

      setupMultiIssueScenario();
      mocks.mockExecute.mockImplementation(async ({ task }: any) => {
        if (task.file.includes("1-test")) {
          return {
            success: false,
            data: { dispatchResult: { task, success: false, error: "persistent error" } },
            error: "persistent error",
            durationMs: 50,
          };
        }
        return {
          success: true,
          data: { dispatchResult: { task, success: true } },
          durationMs: 50,
        };
      });

      const resultPromise = runDispatchPipeline(multiIssueOpts(), "/tmp/test");
      await vi.advanceTimersByTimeAsync(0); // flush ensureAuthReady microtask so createTui runs
      const tui = getMockTui();
      vi.mocked(tui.waitForRecoveryAction).mockImplementationOnce(async () => {
        expect(tui.state.recovery?.selectedAction).toBe("rerun");
        return "quit";
      });
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
      expect(mocks.mockExecute.mock.calls.some((call: any[]) => call[0].task.file.includes("2-bugfix"))).toBe(false);
      expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
      expect(tui.state.tasks[0].status).toBe("failed");

      Object.defineProperty(process.stdin, "isTTY", { value: originalStdIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: originalStdOut, configurable: true });
    });
  });
});

// ─── Error-path handling ────────────────────────────────────────

describe("error-path handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    // Re-establish baseline mocks cleared by vi.clearAllMocks()
    vi.mocked(fetchItemsById).mockResolvedValue([{
      number: "1",
      title: "Test",
      body: "# Test\n\n- [ ] Implement the feature",
      labels: [],
      state: "open",
      url: "https://example.com/1",
      comments: [],
      acceptanceCriteria: "",
    }]);
    vi.mocked(writeItemsToTempDir).mockResolvedValue({
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
    });
    vi.mocked(parseTaskFile).mockResolvedValue(TASK_FILE_FIXTURE);
    vi.mocked(parseIssueFilename).mockReturnValue({ issueId: "1", slug: "test" });
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
  });

  it("propagates error when fetchItemsById rejects during item discovery", async () => {
    vi.mocked(fetchItemsById).mockRejectedValueOnce(new Error("network failure"));

    await expect(
      runDispatchPipeline(baseOpts({ noPlan: true }), "/tmp/test"),
    ).rejects.toThrow("network failure");
  });

  it("logs warning and continues when datasource.update() fails in post-execution sync", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.update).mockRejectedValueOnce(new Error("sync failed"));

    const result = await runDispatchPipeline(
      baseOpts({ noPlan: true }),
      "/tmp/test",
    );

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Could not sync task completion"),
    );
  });

  it("falls back to issueDetailsByFile when parseIssueFilename returns null (md datasource)", async () => {
    // Simulate md-datasource where filenames are non-numeric
    vi.mocked(parseIssueFilename).mockReturnValue(null);
    vi.mocked(writeItemsToTempDir).mockResolvedValue({
      files: ["/tmp/dispatch-test/1-test.md"],
      issueDetailsByFile: new Map([["/tmp/dispatch-test/1-test.md", {
        number: "task-complete-md.md",
        title: "Task Complete MD",
        body: "# Test\n\n- [ ] Implement the feature",
        labels: [],
        state: "open",
        url: ".dispatch/specs/task-complete-md.md",
        comments: [],
        acceptanceCriteria: "",
      }]]),
    });

    const result = await runDispatchPipeline(
      baseOpts({ noPlan: true }),
      "/tmp/test",
    );

    expect(result.completed).toBe(1);
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.update).toHaveBeenCalledWith(
      "task-complete-md.md",
      "Task Complete MD",
      expect.any(String),
      expect.any(Object),
    );
  });
});

// ─── Feature branch workflow ────────────────────────────────────

describe("feature branch workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    setupMultiIssueScenario();
    mocks.mockExecute.mockImplementation(async ({ task }: any) => ({
      success: true,
      data: { dispatchResult: { task, success: true } },
      durationMs: 100,
    }));
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
    // Reset datasource mocks
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockReset().mockResolvedValue(undefined);
    vi.mocked(ds.switchBranch).mockReset().mockResolvedValue(undefined);
    vi.mocked(ds.pushBranch).mockReset().mockResolvedValue(undefined);
    vi.mocked(ds.createPullRequest).mockReset().mockResolvedValue("https://example.com/pr/feature");
    vi.mocked(ds.getDefaultBranch).mockReset().mockResolvedValue("main");
    vi.mocked(ds.getCurrentBranch).mockReset().mockResolvedValue("main");
  });

  function featureOpts(overrides?: Partial<Parameters<typeof runDispatchPipeline>[0]>) {
    return multiIssueOpts({ feature: true, noPlan: true, ...overrides });
  }

  it("creates a feature branch from the default branch", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(vi.mocked(generateFeatureBranchName)).toHaveBeenCalledOnce();
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.getCurrentBranch).toHaveBeenCalled();
    expect(ds.createAndSwitchBranch).toHaveBeenCalledWith(
      "dispatch/feature-abcd1234",
      expect.any(Object),
    );
    // switchBranch must be called before createAndSwitchBranch to ensure the correct base
    const switchOrder = vi.mocked(ds.switchBranch).mock.invocationCallOrder[0];
    const createOrder = vi.mocked(ds.createAndSwitchBranch).mock.invocationCallOrder[0];
    expect(switchOrder).toBeLessThan(createOrder);
  });

  it("switches back to default branch after creating feature branch", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    const switchInvocationOrders = vi.mocked(ds.switchBranch).mock.invocationCallOrder;
    const createOrder = vi.mocked(ds.createAndSwitchBranch).mock.invocationCallOrder[0];
    // First switchBranch call switches TO the default branch (so feature branch has correct base)
    expect(switchInvocationOrders[0]).toBeLessThan(createOrder);
    // Second switchBranch call switches back to the default branch after creating feature branch
    expect(switchInvocationOrders[1]).toBeGreaterThan(createOrder);
  });

  it("creates worktrees with feature branch as start point", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(vi.mocked(createWorktree)).toHaveBeenCalledTimes(2);
    // Verify startPoint parameter is the feature branch name
    for (const call of vi.mocked(createWorktree).mock.calls) {
      expect(call[3]).toBe("dispatch/feature-abcd1234");
    }
  });

  it("merges working branches into feature branch via git merge", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const execCalls = vi.mocked(execFile).mock.calls;
    const mergeCalls = execCalls.filter((call: any[]) =>
      call[0] === "git" && call[1]?.[0] === "merge"
    );

    expect(mergeCalls.length).toBe(2);
    for (const call of mergeCalls) {
      expect(call[1]).toContain("--no-ff");
    }
  });

  it("deletes working branches after merge via git branch -d", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const execCalls = vi.mocked(execFile).mock.calls;
    const deleteCalls = execCalls.filter((call: any[]) =>
      call[0] === "git" && call[1]?.[0] === "branch" && call[1]?.[1] === "-d"
    );

    expect(deleteCalls.length).toBe(2);
  });

  it("removes worktrees before merging in feature mode", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(vi.mocked(removeWorktree)).toHaveBeenCalledTimes(2);
  });

  it("pushes the feature branch after all issues are processed", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.pushBranch).toHaveBeenCalledWith(
      "dispatch/feature-abcd1234",
      expect.any(Object),
    );
  });

  it("creates a single aggregated PR for the feature branch", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    // Should create exactly one PR (the feature PR), not per-issue PRs
    expect(ds.createPullRequest).toHaveBeenCalledOnce();
    expect(ds.createPullRequest).toHaveBeenCalledWith(
      "dispatch/feature-abcd1234",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      "main",
    );
  });

  it("uses buildFeaturePrTitle and buildFeaturePrBody for the aggregated PR", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(vi.mocked(buildFeaturePrTitle)).toHaveBeenCalledWith(
      "dispatch/feature-abcd1234",
      expect.any(Array),
    );
    expect(vi.mocked(buildFeaturePrBody)).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.any(Array),
      "md",
    );
  });

  it("does not push individual working branches", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    const pushCalls = vi.mocked(ds.pushBranch).mock.calls;
    // Only the feature branch should be pushed, not individual issue branches
    expect(pushCalls.length).toBe(1);
    expect(pushCalls[0][0]).toBe("dispatch/feature-abcd1234");
  });

  it("switches back to default branch after feature PR creation", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    const switchCalls = vi.mocked(ds.switchBranch).mock.calls;
    // Last switchBranch call should be switching back to default branch
    const lastCall = switchCalls[switchCalls.length - 1];
    expect(lastCall[0]).toBe("main");
  });

  it("returns correct summary with completed count", async () => {
    const result = await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(2);
  });

  it("fails all tasks when feature branch creation fails", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockRejectedValueOnce(
      new Error("branch creation failed"),
    );

    const result = await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(result.failed).toBe(2);
    expect(result.completed).toBe(0);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("Feature branch creation failed"),
    );
  });

  it("does not create worktrees or process issues when feature branch creation fails", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockRejectedValueOnce(
      new Error("branch creation failed"),
    );

    await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(vi.mocked(createWorktree)).not.toHaveBeenCalled();
    expect(mocks.mockExecute).not.toHaveBeenCalled();
  });

  it("registers cleanup handler for feature branch", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    // registerCleanup should be called for: feature branch + 2 worktrees + 2 providers = 5
    expect(vi.mocked(registerCleanup)).toHaveBeenCalled();
  });

  it("continues gracefully when merge fails", async () => {
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        // Fail git merge calls
        const gitArgs = args[1] as string[];
        if (gitArgs?.[0] === "merge") {
          cb(new Error("merge conflict"), "", "");
          return;
        }
        cb(null, "", "");
      }
    }) as any);

    const result = await runDispatchPipeline(featureOpts(), "/tmp/test");

    // Merge failure is terminal and converts the issue results to failed
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(2);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Could not merge"),
    );
  });

  it("continues gracefully when working branch deletion fails", async () => {
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        const gitArgs = args[1] as string[];
        if (gitArgs?.[0] === "branch" && gitArgs?.[1] === "-d") {
          cb(new Error("branch not found"), "", "");
          return;
        }
        cb(null, "", "");
      }
    }) as any);

    const result = await runDispatchPipeline(featureOpts(), "/tmp/test");

    expect(result.completed).toBe(2);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Could not delete local branch"),
    );
  });

  it("processes issues serially in feature mode (not in parallel)", async () => {
    const executionOrder: string[] = [];
    mocks.mockExecute.mockImplementation(async ({ task }: any) => {
      executionOrder.push(task.text);
      return {
        success: true,
        data: { dispatchResult: { task, success: true } },
        durationMs: 100,
      };
    });

    await runDispatchPipeline(featureOpts(), "/tmp/test");

    // In serial mode, tasks are processed one issue at a time
    expect(executionOrder).toHaveLength(2);
    // The first issue's task should come before the second
    expect(executionOrder[0]).toBe("Implement the feature");
    expect(executionOrder[1]).toBe("Fix the bug");
  });

  it("uses feature branch as defaultBranch for per-issue branch creation", async () => {
    await runDispatchPipeline(featureOpts(), "/tmp/test");

    // In feature mode, the working branches are based on the feature branch.
    // The defaultBranch resolved inside processIssueFile should be featureBranchName.
    // This is verified by checking that createWorktree is called with the feature branch start point.
    const worktreeCalls = vi.mocked(createWorktree).mock.calls;
    for (const call of worktreeCalls) {
      // Fourth arg is startPoint, should be the feature branch
      expect(call[3]).toBe("dispatch/feature-abcd1234");
    }
  });

  it("uses a user-supplied string as the feature branch name with dispatch/ prefix", async () => {
    await runDispatchPipeline(featureOpts({ feature: "my-cool-feature" }), "/tmp/test");

    // Should NOT call generateFeatureBranchName when a string is provided
    expect(vi.mocked(generateFeatureBranchName)).not.toHaveBeenCalled();

    // Should create branch with dispatch/ prefix
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.createAndSwitchBranch).toHaveBeenCalledWith(
      "dispatch/my-cool-feature",
      expect.any(Object),
    );
  });

  it("preserves user-supplied name when it already contains a path separator", async () => {
    await runDispatchPipeline(featureOpts({ feature: "feature/auth-refactor" }), "/tmp/test");

    expect(vi.mocked(generateFeatureBranchName)).not.toHaveBeenCalled();

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.createAndSwitchBranch).toHaveBeenCalledWith(
      "feature/auth-refactor",
      expect.any(Object),
    );
  });

  it("reuses an existing branch when createAndSwitchBranch fails with 'already exists'", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(ds.createAndSwitchBranch).mockRejectedValueOnce(
      new Error("branch 'dispatch/my-feature' already exists"),
    );
    vi.mocked(log.extractMessage).mockReturnValueOnce("branch 'dispatch/my-feature' already exists");

    const result = await runDispatchPipeline(featureOpts({ feature: "my-feature" }), "/tmp/test");

    // Should fall back to switchBranch instead of failing
    expect(ds.switchBranch).toHaveBeenCalledWith("dispatch/my-feature", expect.any(Object));
    // Pipeline should succeed, not fail
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("returns early with all tasks failed when feature branch name is invalid", async () => {
    vi.mocked(isValidBranchName).mockReturnValueOnce(false);

    const result = await runDispatchPipeline(featureOpts({ feature: "invalid..name" }), "/tmp/test");

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.total).toBe(2);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("Invalid feature branch name"),
    );
    // Should not attempt to create any branches or worktrees
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    expect(ds.createAndSwitchBranch).not.toHaveBeenCalled();
    expect(vi.mocked(createWorktree)).not.toHaveBeenCalled();
  });

  it("threads user-supplied feature name through to push and PR creation", async () => {
    await runDispatchPipeline(featureOpts({ feature: "my-feature" }), "/tmp/test");

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    // Verify the feature name is used for push
    expect(ds.pushBranch).toHaveBeenCalledWith(
      "dispatch/my-feature",
      expect.any(Object),
    );
    // Verify the feature name is used for PR creation
    expect(ds.createPullRequest).toHaveBeenCalledWith(
      "dispatch/my-feature",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      "main",
    );
  });

  it("uses user-supplied feature name as worktree start point", async () => {
    await runDispatchPipeline(featureOpts({ feature: "my-feature" }), "/tmp/test");

    const worktreeCalls = vi.mocked(createWorktree).mock.calls;
    expect(worktreeCalls.length).toBe(2);
    for (const call of worktreeCalls) {
      expect(call[3]).toBe("dispatch/my-feature");
    }
  });
});

describe("md-datasource sync fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    // Set up md-datasource-style issue with non-numeric filename as the number
    const mdIssue: IssueDetails = {
      number: "task-complete-md.md",
      title: "Task Complete Md",
      body: "# Task\n\n- [ ] Implement the feature",
      labels: [],
      state: "open",
      url: ".dispatch/specs/task-complete-md.md",
      comments: [],
      acceptanceCriteria: "",
    };

    vi.mocked(fetchItemsById).mockResolvedValue([mdIssue]);
    vi.mocked(writeItemsToTempDir).mockResolvedValue({
      files: ["/tmp/dispatch-test/task-complete-md.md"],
      issueDetailsByFile: new Map([
        ["/tmp/dispatch-test/task-complete-md.md", mdIssue],
      ]),
    });
    vi.mocked(parseTaskFile).mockResolvedValue({
      path: "/tmp/dispatch-test/task-complete-md.md",
      tasks: [{
        index: 0,
        text: "Implement the feature",
        line: 3,
        raw: "- [ ] Implement the feature",
        file: "/tmp/dispatch-test/task-complete-md.md",
      }],
      content: "# Task\n\n- [ ] Implement the feature",
    });
    // Return null to simulate non-numeric md-datasource filename
    vi.mocked(parseIssueFilename).mockReturnValue(null);
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: { index: 0, text: "Implement the feature", line: 3, raw: "- [ ] Implement the feature", file: "/tmp/dispatch-test/task-complete-md.md" }, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
  });

  it("calls datasource.update() with filename-based issue ID when parseIssueFilename returns null", async () => {
    const result = await runDispatchPipeline(
      baseOpts({ noPlan: true }),
      "/tmp/test",
    );

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);

    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    // datasource.update() should be called with the original md filename as issueId
    expect(ds.update).toHaveBeenCalledWith(
      "task-complete-md.md",
      "Task Complete Md",
      expect.any(String),
      expect.any(Object),
    );
  });
});

describe("glob expansion in dispatch pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
    mocks.mockPlan.mockImplementation(() =>
      new Promise<SkillResult<PlannerData>>((resolve) => {
        setTimeout(() => resolve({ data: { prompt: "Execute step 1" }, success: true, durationMs: 100 }), 100);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses resolveGlobItems when source is md and issueIds contain glob patterns", async () => {
    mocks.mockGlob.mockResolvedValue(["/tmp/specs/feature.md"]);
    vi.mocked(readFile).mockResolvedValue("# Feature\n\n- [ ] Implement the feature");
    vi.mocked(writeItemsToTempDir).mockResolvedValue({
      files: ["/tmp/dispatch-test/feature.md"],
      issueDetailsByFile: new Map([["/tmp/dispatch-test/feature.md", {
        number: "/tmp/specs/feature.md",
        title: "Feature",
        body: "# Feature\n\n- [ ] Implement the feature",
        labels: [],
        state: "open",
        url: "/tmp/specs/feature.md",
        comments: [],
        acceptanceCriteria: "",
      }]]),
    });

    const resultPromise = runDispatchPipeline(
      baseOpts({ issueIds: ["./specs/*.md"], source: "md" }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(vi.mocked(glob)).toHaveBeenCalledWith(["./specs/*.md"], { cwd: "/tmp/test", absolute: true });
    expect(vi.mocked(fetchItemsById)).not.toHaveBeenCalled();
    expect(result.completed).toBe(1);
  });

  it("processes multiple matched files from glob as separate task items", async () => {
    mocks.mockGlob.mockResolvedValue(["/tmp/specs/one.md", "/tmp/specs/two.md"]);
    vi.mocked(readFile).mockResolvedValue("# Task\n\n- [ ] Do something");
    vi.mocked(writeItemsToTempDir).mockResolvedValue({
      files: ["/tmp/dispatch-test/one.md", "/tmp/dispatch-test/two.md"],
      issueDetailsByFile: new Map([
        ["/tmp/dispatch-test/one.md", {
          number: "/tmp/specs/one.md",
          title: "Task",
          body: "# Task\n\n- [ ] Do something",
          labels: [],
          state: "open",
          url: "/tmp/specs/one.md",
          comments: [],
          acceptanceCriteria: "",
        }],
        ["/tmp/dispatch-test/two.md", {
          number: "/tmp/specs/two.md",
          title: "Task",
          body: "# Task\n\n- [ ] Do something",
          labels: [],
          state: "open",
          url: "/tmp/specs/two.md",
          comments: [],
          acceptanceCriteria: "",
        }],
      ]),
    });
    vi.mocked(parseTaskFile)
      .mockResolvedValueOnce({
        path: "/tmp/dispatch-test/one.md",
        tasks: [{ index: 0, text: "Do something", line: 3, raw: "- [ ] Do something", file: "/tmp/dispatch-test/one.md" }],
        content: "# Task\n\n- [ ] Do something",
      })
      .mockResolvedValueOnce({
        path: "/tmp/dispatch-test/two.md",
        tasks: [{ index: 0, text: "Do something", line: 3, raw: "- [ ] Do something", file: "/tmp/dispatch-test/two.md" }],
        content: "# Task\n\n- [ ] Do something",
      });

    const resultPromise = runDispatchPipeline(
      baseOpts({ issueIds: ["docs/**/*.md"], source: "md" }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(vi.mocked(glob)).toHaveBeenCalledWith(["docs/**/*.md"], { cwd: "/tmp/test", absolute: true });
    expect(result.total).toBe(2);
  });

  it("returns empty summary when glob matches no files", async () => {
    mocks.mockGlob.mockResolvedValue([]);

    const resultPromise = runDispatchPipeline(
      baseOpts({ issueIds: ["nonexistent/*.md"], source: "md" }),
      "/tmp/test",
    );
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toEqual({ total: 0, completed: 0, failed: 0, skipped: 0, results: [] });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("No files matched"));
  });

  it("falls back to fetchItemsById when source is md but issueIds are plain numbers", async () => {
    const resultPromise = runDispatchPipeline(
      baseOpts({ issueIds: ["42"], source: "md" }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(vi.mocked(glob)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchItemsById)).toHaveBeenCalled();
  });

  it("does not use glob when source is not md even with glob-like issueIds", async () => {
    const ds = vi.mocked(getDatasource)("md") as unknown as Datasource;
    vi.mocked(getDatasource).mockReturnValue(ds);

    const resultPromise = runDispatchPipeline(
      baseOpts({ issueIds: ["*.md"], source: "github" as any }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    expect(vi.mocked(glob)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchItemsById)).toHaveBeenCalled();
  });

  it("uses resolveGlobItems in dryRunMode when source is md with glob patterns", async () => {
    mocks.mockGlob.mockResolvedValue(["/tmp/specs/task.md"]);
    vi.mocked(readFile).mockResolvedValue("# Dry Run Task\n\n- [ ] Check something");

    const result = await dryRunMode(["./specs/*.md"], "/tmp/test", "md");

    expect(vi.mocked(glob)).toHaveBeenCalledWith(["./specs/*.md"], { cwd: "/tmp/test", absolute: true });
    expect(vi.mocked(fetchItemsById)).not.toHaveBeenCalled();
    expect(result.skipped).toBe(result.total);
  });

  it("handles relative path issueIds as glob input", async () => {
    mocks.mockGlob.mockResolvedValue(["/tmp/test/my-specs/task.md"]);
    vi.mocked(readFile).mockResolvedValue("# Relative Task\n\n- [ ] Implement it");
    vi.mocked(writeItemsToTempDir).mockResolvedValue({
      files: ["/tmp/dispatch-test/task.md"],
      issueDetailsByFile: new Map([["/tmp/dispatch-test/task.md", {
        number: "/tmp/test/my-specs/task.md",
        title: "Relative Task",
        body: "# Relative Task\n\n- [ ] Implement it",
        labels: [],
        state: "open",
        url: "/tmp/test/my-specs/task.md",
        comments: [],
        acceptanceCriteria: "",
      }]]),
    });

    const resultPromise = runDispatchPipeline(
      baseOpts({ issueIds: ["./my-specs/task.md"], source: "md" }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(vi.mocked(glob)).toHaveBeenCalledWith(["./my-specs/task.md"], { cwd: "/tmp/test", absolute: true });
    expect(result.completed).toBe(1);
  });
});

describe("auth prompt handler cleanup on error", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls setAuthPromptHandler(null) when pipeline throws an error", async () => {
    vi.mocked(fetchItemsById).mockRejectedValueOnce(new Error("network failure"));

    await expect(
      runDispatchPipeline(baseOpts(), "/tmp/test"),
    ).rejects.toThrow("network failure");

    expect(vi.mocked(setAuthPromptHandler)).toHaveBeenCalledWith(null);
  });

  it("calls setAuthPromptHandler(null) on normal pipeline completion", async () => {
    const resultPromise = runDispatchPipeline(baseOpts(), "/tmp/test");
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toBeDefined();
    expect(vi.mocked(setAuthPromptHandler)).toHaveBeenCalledWith(null);
  });
});

describe("git rev-parse shell option for Windows compatibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupMockDispatch();
    resetAuthMocks();
    mocks.mockPlan.mockResolvedValue({
      data: { prompt: "Execute step 1" },
      success: true,
      durationMs: 100,
    });
    mocks.mockExecute.mockResolvedValue({
      success: true,
      data: { dispatchResult: { task: TASK_FIXTURE, success: true } },
      durationMs: 100,
    });
    mocks.mockGenerate.mockResolvedValue({
      data: null,
      success: false,
      error: "mock: not configured",
      durationMs: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes shell option to git rev-parse --git-dir for md datasource", async () => {
    const resultPromise = runDispatchPipeline(
      baseOpts({ source: "md", noBranch: false }),
      "/tmp/test",
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await resultPromise;

    // Verify execFile was called with shell option for git rev-parse
    const execFileCalls = vi.mocked(execFile).mock.calls;
    const revParseCall = execFileCalls.find(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1].includes("rev-parse"),
    );
    if (revParseCall) {
      const options = revParseCall[2] as Record<string, unknown>;
      expect(options).toHaveProperty("shell", process.platform === "win32");
    }
  });
});
