import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../parser.js";
import type { ProviderInstance } from "../providers/interface.js";
import { createMockProvider, createMockTask } from "./fixtures.js";
import type { Skill } from "../skills/interface.js";
import type { ExecutorData } from "../skills/types.js";
import { executorSkill } from "../skills/executor.js";

vi.mock("../helpers/logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
    formatErrorChain: vi.fn().mockReturnValue("mock error chain"),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("../helpers/file-logger.js", () => ({
  fileLoggerStorage: {
    getStore: vi.fn().mockReturnValue(null),
  },
}));

import { dispatch } from "../dispatcher.js";

const TASK_FIXTURE = createMockTask();

describe("dispatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns success when provider responds (no plan)", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledOnce();

    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Implement the widget");
    expect(prompt).toContain("/tmp/test");
    expect(prompt).toContain("/tmp/test/42-feature.md");
    expect(prompt).toContain("line 3");
    expect(prompt).not.toContain("Execution Plan");
  });

  it("returns success with planned prompt when plan is provided", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
    }, provider);

    expect(result.success).toBe(true);

    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Execution Plan");
    expect(prompt).toContain("Step 1: do X");
  });

  it("returns failure with error when provider returns null", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(null),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toBe("No response");
  });

  it("returns failure when createSession throws an Error", async () => {
    const provider = createMockProvider({
      createSession: vi.fn<ProviderInstance["createSession"]>().mockRejectedValue(
        new Error("Session creation failed")
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Session creation failed");
    expect(provider.prompt).not.toHaveBeenCalled();
  });

  it("returns failure when prompt throws an Error", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockRejectedValue(new Error("Prompt failed")),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Prompt failed");
  });

  it("handles non-Error exceptions", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockRejectedValue("raw string error"),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toBe("raw string error");
  });

  it("handles empty task text", async () => {
    const provider = createMockProvider();
    const emptyTask: Task = {
      index: 1,
      text: "",
      line: 5,
      raw: "- [ ] ",
      file: "/tmp/test/42-feature.md",
    };
    const result = await dispatch(executorSkill, {
      task: emptyTask,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
  });

  it("includes commit instruction when task text mentions commit", async () => {
    const provider = createMockProvider();
    const commitTask: Task = {
      ...TASK_FIXTURE,
      text: "Fix bug. Commit with message: fix: resolve bug",
    };
    const result = await dispatch(executorSkill, {
      task: commitTask,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("stage all changes and create a conventional commit");
  });

  it("excludes commit instruction when task text does not mention commit", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Do NOT commit changes");
  });

  it("includes worktree isolation instructions when worktreeRoot is provided", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
      worktreeRoot: "/tmp/worktree",
    }, provider);

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Worktree isolation");
    expect(prompt).toContain("/tmp/worktree");
    expect(prompt).toContain("MUST NOT read, write, or execute commands that access files outside");
  });

  it("excludes worktree isolation instructions when worktreeRoot is not provided", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).not.toContain("Worktree isolation");
  });

  it("includes worktree isolation in planned prompt when worktreeRoot is provided", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
      worktreeRoot: "/tmp/worktree",
    }, provider);

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Execution Plan");
    expect(prompt).toContain("Step 1: do X");
    expect(prompt).toContain("Worktree isolation");
    expect(prompt).toContain("/tmp/worktree");
  });

  it("includes environment section in prompt (no plan)", async () => {
    const provider = createMockProvider();
    await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });

  it("includes environment section in planned prompt", async () => {
    const provider = createMockProvider();
    await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
    }, provider);

    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });

  it("detects 'You've hit your limit' as rate-limit failure", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(
        "You've hit your limit \u00b7 resets 6pm (UTC)"
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });

  it("detects 'rate limit exceeded' as rate-limit failure", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(
        "rate limit exceeded, please try again later"
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });

  it("detects 'Too many requests' as rate-limit failure", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(
        "Too many requests"
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });

  it("detects 'quota exceeded' as rate-limit failure", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(
        "Your quota exceeded for today"
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });

  it("treats normal response as success", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(
        "Task complete. I've implemented the changes as requested."
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
  });

  it("does not false-positive on 'limit' in normal task output", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(
        "I've implemented the rate limiting feature as requested. Task complete."
      ),
    });
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.success).toBe(true);
  });

  it("works with a simple custom skill", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("hello world"),
    });

    const simpleSkill: Skill<{ msg: string }, string> = {
      name: "planner",
      buildPrompt(input) { return input.msg; },
      parseResult(response) { return response ?? ""; },
    };

    const result = await dispatch(simpleSkill, { msg: "test prompt" }, provider);

    expect(result.success).toBe(true);
    expect(result.data).toBe("hello world");
    expect(vi.mocked(provider.prompt).mock.calls[0][1]).toBe("test prompt");
  });

  it("records durationMs", async () => {
    const provider = createMockProvider();
    const result = await dispatch(executorSkill, {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    }, provider);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
