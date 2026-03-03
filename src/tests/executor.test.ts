import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../parser.js";
import type { ProviderInstance } from "../providers/interface.js";
import type { DispatchResult } from "../dispatcher.js";

vi.mock("../dispatcher.js", () => ({
  dispatchTask: vi.fn(),
}));

vi.mock("../parser.js", () => ({
  markTaskComplete: vi.fn(),
}));

import { dispatchTask } from "../dispatcher.js";
import { markTaskComplete } from "../parser.js";
import { boot } from "../agents/executor.js";

function createMockProvider(overrides?: Partial<ProviderInstance>): ProviderInstance {
  return {
    name: "mock",
    model: "mock-model",
    createSession: vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("session-1"),
    prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done"),
    cleanup: vi.fn<ProviderInstance["cleanup"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

const TASK_FIXTURE: Task = {
  index: 0,
  text: "Implement the widget",
  line: 3,
  raw: "- [ ] Implement the widget",
  file: "/tmp/test/42-feature.md",
};

describe("boot", () => {
  it("throws when provider is not supplied", async () => {
    await expect(boot({ cwd: "/tmp" })).rejects.toThrow(
      "Executor agent requires a provider instance in boot options"
    );
  });

  it("returns an agent with name 'executor'", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(agent.name).toBe("executor");
  });

  it("returns an agent with execute and cleanup methods", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(typeof agent.execute).toBe("function");
    expect(typeof agent.cleanup).toBe("function");
  });
});

describe("execute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls dispatchTask and markTaskComplete on success", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);
    const mockMarkComplete = vi.mocked(markTaskComplete);

    const dispatchResult: DispatchResult = {
      task: TASK_FIXTURE,
      success: true,
    };
    mockDispatch.mockResolvedValue(dispatchResult);
    mockMarkComplete.mockResolvedValue(undefined);

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X\nStep 2: do Y",
    });

    expect(result.success).toBe(true);
    expect(result.dispatchResult).toBe(dispatchResult);
    expect(result.error).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // dispatchTask called with provider, task, cwd, and plan string
    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch).toHaveBeenCalledWith(
      provider,
      TASK_FIXTURE,
      "/tmp/test",
      "Step 1: do X\nStep 2: do Y",
      undefined,
    );

    // markTaskComplete called on success
    expect(mockMarkComplete).toHaveBeenCalledOnce();
    expect(mockMarkComplete).toHaveBeenCalledWith(TASK_FIXTURE);
  });

  it("surfaces dispatch failure without calling markTaskComplete", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);
    const mockMarkComplete = vi.mocked(markTaskComplete);

    const dispatchResult: DispatchResult = {
      task: TASK_FIXTURE,
      success: false,
      error: "No response from agent",
    };
    mockDispatch.mockResolvedValue(dispatchResult);

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Some plan",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No response from agent");
    expect(result.dispatchResult).toBe(dispatchResult);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // markTaskComplete should NOT be called when dispatch fails
    expect(mockMarkComplete).not.toHaveBeenCalled();
  });

  it("catches dispatchTask exceptions and returns a failure result", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);
    const mockMarkComplete = vi.mocked(markTaskComplete);

    mockDispatch.mockRejectedValue(new Error("Session creation failed"));

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Some plan",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Session creation failed");
    expect(result.dispatchResult.success).toBe(false);
    expect(result.dispatchResult.task).toBe(TASK_FIXTURE);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(mockMarkComplete).not.toHaveBeenCalled();
  });

  it("passes undefined to dispatchTask when plan is null (non-planned path)", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);
    const mockMarkComplete = vi.mocked(markTaskComplete);

    const dispatchResult: DispatchResult = {
      task: TASK_FIXTURE,
      success: true,
    };
    mockDispatch.mockResolvedValue(dispatchResult);
    mockMarkComplete.mockResolvedValue(undefined);

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(result.success).toBe(true);

    // When plan is null, dispatchTask should receive `undefined` as the 4th arg
    // This triggers the generic (non-planned) prompt path in the dispatcher
    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch).toHaveBeenCalledWith(
      provider,
      TASK_FIXTURE,
      "/tmp/test",
      undefined,
      undefined,
    );

    expect(mockMarkComplete).toHaveBeenCalledOnce();
  });

  it("handles non-Error exceptions from dispatchTask", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);

    mockDispatch.mockRejectedValue("raw string error");

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("raw string error");
  });

  it("tracks elapsed time in milliseconds", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);
    const mockMarkComplete = vi.mocked(markTaskComplete);

    // Add a small delay to ensure elapsedMs > 0
    mockDispatch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { task: TASK_FIXTURE, success: true };
    });
    mockMarkComplete.mockResolvedValue(undefined);

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "plan",
    });

    expect(result.elapsedMs).toBeGreaterThanOrEqual(20);
    expect(result.elapsedMs).toBeLessThan(2000);
  });

  it("passes worktreeRoot to dispatchTask when provided in input", async () => {
    const provider = createMockProvider();
    const mockDispatch = vi.mocked(dispatchTask);
    const mockMarkComplete = vi.mocked(markTaskComplete);

    const dispatchResult: DispatchResult = {
      task: TASK_FIXTURE,
      success: true,
    };
    mockDispatch.mockResolvedValue(dispatchResult);
    mockMarkComplete.mockResolvedValue(undefined);

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.execute({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
      worktreeRoot: "/tmp/worktree",
    });

    expect(result.success).toBe(true);
    expect(mockDispatch).toHaveBeenCalledWith(
      provider,
      TASK_FIXTURE,
      "/tmp/test",
      "Step 1: do X",
      "/tmp/worktree",
    );
  });
});
