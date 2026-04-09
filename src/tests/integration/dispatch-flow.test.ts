import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { ProviderInstance } from "../../providers/interface.js";
import type { PlannerAgent } from "../../agents/planner.js";
import type { AgentResult, PlannerData, ExecutorData } from "../../agents/types.js";
import type { Task } from "../../parser.js";
import { markTaskComplete } from "../../parser.js";

// ─── Hoisted mock references ────────────────────────────────────────

const { mocks } = vi.hoisted(() => {
  const mockCreateSession = vi.fn().mockResolvedValue("session-1");
  const mockPrompt = vi.fn().mockResolvedValue("Task complete.");
  const mockProviderCleanup = vi.fn().mockResolvedValue(undefined);

  const mockPlan = vi.fn().mockResolvedValue({
    data: { prompt: "Execute the task as described." },
    success: true,
    durationMs: 100,
  } satisfies AgentResult<PlannerData>);
  const mockPlannerCleanup = vi.fn().mockResolvedValue(undefined);

  const mockExecute = vi.fn();
  const mockExecutorCleanup = vi.fn().mockResolvedValue(undefined);

  return {
    mocks: {
      mockCreateSession,
      mockPrompt,
      mockProviderCleanup,
      mockPlan,
      mockPlannerCleanup,
      mockExecute,
      mockExecutorCleanup,
    },
  };
});

// ─── Module mocks (only provider, agents, TUI, cleanup, logger, worktree) ───

vi.mock("../../providers/index.js", () => ({
  bootProvider: vi.fn().mockResolvedValue({
    name: "mock-provider",
    model: "mock-model",
    createSession: mocks.mockCreateSession,
    prompt: mocks.mockPrompt,
    cleanup: mocks.mockProviderCleanup,
  } satisfies ProviderInstance),
  getAuthenticatedProviders: vi.fn().mockResolvedValue(["opencode"]),
  checkProviderAuthenticated: vi.fn().mockResolvedValue(true),
  getProviderAuthStatus: vi.fn().mockResolvedValue({ status: "authenticated" }),
  PROVIDER_NAMES: ["opencode", "copilot", "claude", "codex"],
}));

vi.mock("../../providers/router.js", () => ({
  routeAllAgents: vi.fn().mockReturnValue({
    planner: [{ provider: "opencode", model: "claude-haiku-4", priority: 0 }],
    executor: [{ provider: "opencode", model: "claude-sonnet-4-5", priority: 0 }],
    commit: [{ provider: "opencode", model: "claude-haiku-4", priority: 0 }],
  }),
  routeAgent: vi.fn().mockReturnValue([{ provider: "opencode", model: "claude-sonnet-4-5", priority: 0 }]),
}));

vi.mock("../../agents/planner.js", () => ({
  boot: vi.fn().mockResolvedValue({
    name: "planner",
    plan: mocks.mockPlan,
    cleanup: mocks.mockPlannerCleanup,
  } satisfies PlannerAgent),
}));

vi.mock("../../agents/executor.js", () => ({
  boot: vi.fn().mockResolvedValue({
    name: "executor",
    execute: mocks.mockExecute,
    cleanup: mocks.mockExecutorCleanup,
  }),
}));

vi.mock("../../tui.js", () => ({
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

vi.mock("../../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../../helpers/auth.js", () => ({
  getGithubOctokit: vi.fn().mockResolvedValue({}),
  getAzureConnection: vi.fn().mockResolvedValue({}),
  setAuthPromptHandler: vi.fn(),
  ensureAuthReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../helpers/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue("/tmp/mock-worktree"),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  worktreeName: vi.fn().mockReturnValue("mock-worktree"),
}));

vi.mock("../../helpers/logger.js", () => ({
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
    extractMessage: vi.fn((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    ),
  },
}));

// ─── Import function under test (after mocks) ──────────────────────

import { runDispatchPipeline } from "../../orchestrator/dispatch-pipeline.js";
import { createTui } from "../../tui.js";
import { log } from "../../helpers/logger.js";

// ─── Test suite ─────────────────────────────────────────────────────

describe("integration: dispatch pipeline with md datasource", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Configure the mock executor to simulate success.
    // It must call markTaskComplete to update the file (checking off the task),
    // mimicking what the real executor does.
    mocks.mockExecute.mockImplementation(
      async (input: { task: Task; cwd: string; plan: string | null }): Promise<AgentResult<ExecutorData>> => {
        await markTaskComplete(input.task);
        return {
          data: { dispatchResult: { task: input.task, success: true } },
          success: true,
          durationMs: 50,
        };
      },
    );
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs the full dispatch pipeline with a real md datasource and parser", async () => {
    // ── (a) Set up a real temp directory ─────────────────────────
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));

    // ── (b) Initialize a git repo with spec file ────────────────
    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });

    const specContent = [
      "# Test Feature",
      "",
      "Implement a test feature for the dispatch pipeline.",
      "",
      "## Tasks",
      "",
      "- [ ] Create the widget component",
      "- [ ] Add unit tests for the widget",
    ].join("\n");

    await writeFile(join(specsDir, "test-feature.md"), specContent, "utf-8");

    // Initialize git repo (required for md datasource's getUsername)
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });

    // ── (f) Call runDispatchPipeline ─────────────────────────────
    const result = await runDispatchPipeline(
      {
        issueIds: [],
        concurrency: 1,
        dryRun: false,
        noPlan: false,
        noBranch: true,
        provider: "opencode",
        enabledProviders: ["opencode"],
        source: "md",
        planTimeout: 1,
        planRetries: 0,
      },
      tmpDir,
    );

    // ── (g) Verify the returned DispatchSummary ─────────────────
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.completed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThanOrEqual(1);

    // Verify each result entry is valid
    for (const r of result.results) {
      expect(r.task).toBeDefined();
      expect(r.success).toBe(true);
    }

    // Verify the planner was called for each task
    expect(mocks.mockPlan).toHaveBeenCalledTimes(result.total);

    // Verify the executor was called for each task
    expect(mocks.mockExecute).toHaveBeenCalledTimes(result.total);
  }, 15_000);

  it("handles a single-task spec file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));

    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });

    const specContent = [
      "# Single Task Spec",
      "",
      "- [ ] Implement the single feature",
    ].join("\n");

    await writeFile(join(specsDir, "single-task.md"), specContent, "utf-8");

    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });

    const result = await runDispatchPipeline(
      {
        issueIds: [],
        concurrency: 1,
        dryRun: false,
        noPlan: false,
        noBranch: true,
        provider: "opencode",
        enabledProviders: ["opencode"],
        source: "md",
        planTimeout: 1,
        planRetries: 0,
      },
      tmpDir,
    );

    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
  }, 15_000);

  it("completes with noPlan mode (skips planning)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));

    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });

    await writeFile(
      join(specsDir, "no-plan-spec.md"),
      "# No Plan\n\n- [ ] Do the thing\n",
      "utf-8",
    );

    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });

    const result = await runDispatchPipeline(
      {
        issueIds: [],
        concurrency: 1,
        dryRun: false,
        noPlan: true,
        noBranch: true,
        provider: "opencode",
        enabledProviders: ["opencode"],
        source: "md",
        planTimeout: 1,
        planRetries: 0,
      },
      tmpDir,
    );

    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    // Planner should NOT have been called
    expect(mocks.mockPlan).not.toHaveBeenCalled();
    // Executor should still run
    expect(mocks.mockExecute).toHaveBeenCalledOnce();
  }, 15_000);

  it("reruns a paused task from the normal lifecycle entry point", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));

    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "rerun-spec.md"), "# Rerun\n\n- [ ] Recover the task\n", "utf-8");

    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });

    const originalStdIn = process.stdin.isTTY;
    const originalStdOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    let executeCalls = 0;
    mocks.mockExecute.mockImplementation(async (input: { task: Task; cwd: string; plan: string | null }): Promise<AgentResult<ExecutorData>> => {
      executeCalls++;
      if (executeCalls <= 4) {
        return {
          data: null,
          success: false,
          error: "retry me",
          durationMs: 50,
        };
      }
      await markTaskComplete(input.task);
      return {
        data: { dispatchResult: { task: input.task, success: true } },
        success: true,
        durationMs: 50,
      };
    });

    const resultPromise = runDispatchPipeline(
      {
        issueIds: [],
        concurrency: 1,
        dryRun: false,
        noPlan: false,
        noBranch: true,
        provider: "opencode",
        enabledProviders: ["opencode"],
        source: "md",
        planTimeout: 1,
        planRetries: 0,
      },
      tmpDir,
    );

    // Flush the ensureAuthReady microtask so createTui() runs synchronously after
    await Promise.resolve();
    const tui = vi.mocked(createTui).mock.results[0]!.value;
    vi.mocked(tui.waitForRecoveryAction).mockImplementationOnce(async () => {
      expect(tui.state.recovery?.selectedAction).toBe("rerun");
      return "rerun";
    });

    const result = await resultPromise;

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.mockPlan).toHaveBeenCalledTimes(2);
    expect(mocks.mockExecute).toHaveBeenCalledTimes(5);

    Object.defineProperty(process.stdin, "isTTY", { value: originalStdIn, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdOut, configurable: true });
  }, 15_000);

  it("fails cleanly without recovery input when retries exhaust in non-interactive mode", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));

    const specsDir = join(tmpDir, ".dispatch", "specs");
    await mkdir(specsDir, { recursive: true });
    const specPath = join(specsDir, "non-interactive-recovery.md");
    await writeFile(specPath, "# Retry\n\n- [ ] Leave this unchecked\n", "utf-8");

    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });

    const originalStdIn = process.stdin.isTTY;
    const originalStdOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    try {
      mocks.mockExecute.mockResolvedValue({
        data: null,
        success: false,
        error: "retry me later",
        durationMs: 50,
      });

      const result = await runDispatchPipeline(
        {
          issueIds: [],
          concurrency: 1,
          dryRun: false,
          noPlan: false,
          noBranch: true,
          provider: "opencode",
          source: "md",
          planTimeout: 1,
          planRetries: 0,
        },
        tmpDir,
      );

      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);

      const tui = vi.mocked(createTui).mock.results[0]!.value;
      expect(tui.waitForRecoveryAction).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));

      const persistedSpec = await readFile(specPath, "utf-8");
      expect(persistedSpec).toContain("- [ ] Leave this unchecked");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalStdIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: originalStdOut, configurable: true });
    }
  }, 15_000);
});
