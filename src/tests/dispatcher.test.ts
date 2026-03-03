import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../parser.js";
import type { ProviderInstance } from "../providers/interface.js";

vi.mock("../helpers/logger.js", () => ({
  log: {
    debug: vi.fn(),
    formatErrorChain: vi.fn().mockReturnValue("mock error chain"),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

import { dispatchTask } from "../dispatcher.js";

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

describe("dispatchTask", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns success when provider responds (no plan)", async () => {
    const provider = createMockProvider();
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test");

    expect(result).toEqual({ task: TASK_FIXTURE, success: true });
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
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test", "Step 1: do X");

    expect(result).toEqual({ task: TASK_FIXTURE, success: true });

    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Execution Plan");
    expect(prompt).toContain("Step 1: do X");
  });

  it("returns failure with error when provider returns null", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(null),
    });
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test");

    expect(result).toEqual({
      task: TASK_FIXTURE,
      success: false,
      error: "No response from agent",
    });
  });

  it("returns failure when createSession throws an Error", async () => {
    const provider = createMockProvider({
      createSession: vi.fn<ProviderInstance["createSession"]>().mockRejectedValue(
        new Error("Session creation failed")
      ),
    });
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test");

    expect(result).toEqual({
      task: TASK_FIXTURE,
      success: false,
      error: "Session creation failed",
    });
    expect(provider.prompt).not.toHaveBeenCalled();
  });

  it("returns failure when prompt throws an Error", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockRejectedValue(new Error("Prompt failed")),
    });
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test");

    expect(result).toEqual({
      task: TASK_FIXTURE,
      success: false,
      error: "Prompt failed",
    });
  });

  it("handles non-Error exceptions", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockRejectedValue("raw string error"),
    });
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test");

    expect(result).toEqual({
      task: TASK_FIXTURE,
      success: false,
      error: "raw string error",
    });
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
    const result = await dispatchTask(provider, emptyTask, "/tmp/test");

    expect(result).toEqual({ task: emptyTask, success: true });
  });

  it("includes commit instruction when task text mentions commit", async () => {
    const provider = createMockProvider();
    const commitTask: Task = {
      ...TASK_FIXTURE,
      text: "Fix bug. Commit with message: fix: resolve bug",
    };
    const result = await dispatchTask(provider, commitTask, "/tmp/test");

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("stage all changes and create a conventional commit");
  });

  it("excludes commit instruction when task text does not mention commit", async () => {
    const provider = createMockProvider();
    const result = await dispatchTask(provider, TASK_FIXTURE, "/tmp/test");

    expect(result.success).toBe(true);
    const prompt = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(prompt).toContain("Do NOT commit changes");
  });
});
