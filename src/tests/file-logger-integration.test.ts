import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskFile } from "../parser.js";
import type { Skill } from "../skills/interface.js";
import type { SkillResult, PlannerData } from "../skills/types.js";
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

  const mockPlan = vi.fn();
  const mockExecute = vi.fn();
  const mockGenerate = vi.fn();
  const mockDispatch = vi.fn();
  const mockCreateSession = vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("sess-1");
  const mockPrompt = vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done");
  const mockCleanup = vi.fn().mockResolvedValue(undefined);

  return {
    mocks: { mockPlan, mockExecute, mockGenerate, mockDispatch, mockCreateSession, mockPrompt, mockCleanup },
    TASK_FIXTURE,
    TASK_FILE_FIXTURE,
  };
});

// ─── Module mocks ───────────────────────────────────────────────────
// Mock everything EXCEPT logger.js, file-logger.js, and node:fs

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
  generateFeatureBranchName: vi.fn().mockReturnValue("dispatch/feature-abcd1234"),
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
  closeCompletedSpecIssues: vi.fn().mockResolvedValue(undefined),
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
    if (typeof cb === "function") cb(null, "", "");
  }),
}));

vi.mock("../helpers/format.js", () => ({
  elapsed: vi.fn().mockReturnValue("0s"),
  renderHeaderLines: vi.fn().mockReturnValue(["mock-header"]),
}));

// ─── Import function under test (after mocks) ──────────────────────

import { runDispatchPipeline } from "../orchestrator/dispatch-pipeline.js";
import { log } from "../helpers/logger.js";
import { fileLoggerStorage } from "../helpers/file-logger.js";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    planTimeout: 1,
    planRetries: 1,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("integration: verbose file logging", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "dispatch-file-logger-"));
    log.verbose = true;

    // Suppress console output during tests
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Set up dispatch mock routing
    mocks.mockDispatch.mockImplementation(async (skill: Skill<any, any>, input: any) => {
      if (skill.name === "planner") return mocks.mockPlan(input);
      if (skill.name === "executor") return mocks.mockExecute(input);
      if (skill.name === "commit") return mocks.mockGenerate(input);
      throw new Error(`Unknown skill: ${skill.name}`);
    });

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
    log.verbose = false;
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("produces a log file when verbose mode is enabled", async () => {
    await runDispatchPipeline(baseOpts(), tmpDir);

    const logPath = join(tmpDir, ".dispatch", "logs", "issue-1.log");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("log file lines have ISO 8601 timestamps", async () => {
    await runDispatchPipeline(baseOpts(), tmpDir);

    const logPath = join(tmpDir, ".dispatch", "logs", "issue-1.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/m);
  });

  it("log file contains phase markers", async () => {
    await runDispatchPipeline(baseOpts(), tmpDir);

    const logPath = join(tmpDir, ".dispatch", "logs", "issue-1.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).toContain("[PHASE]");
    expect(content).toContain("═");
  });

  it("log file contains structured info entries", async () => {
    await runDispatchPipeline(baseOpts(), tmpDir);

    const logPath = join(tmpDir, ".dispatch", "logs", "issue-1.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).toContain("[INFO]");
  });

  it("non-verbose mode produces no log files", async () => {
    log.verbose = false;

    await runDispatchPipeline(baseOpts(), tmpDir);

    const logPath = join(tmpDir, ".dispatch", "logs", "issue-1.log");
    expect(existsSync(logPath)).toBe(false);
  });

  it("AsyncLocalStorage context does not leak after pipeline completes", async () => {
    await runDispatchPipeline(baseOpts(), tmpDir);

    expect(fileLoggerStorage.getStore()).toBeUndefined();
  });
});
