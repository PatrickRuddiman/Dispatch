import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../parser.js";
import type { ProviderInstance } from "../providers/interface.js";
import { boot } from "../agents/planner.js";

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
      "Planner agent requires a provider instance in boot options"
    );
  });

  it("returns an agent with name 'planner'", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(agent.name).toBe("planner");
  });

  it("returns an agent with plan and cleanup methods", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(typeof agent.plan).toBe("function");
    expect(typeof agent.cleanup).toBe("function");
  });
});

describe("plan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates a session and prompts the provider", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("Step 1: do X"),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining("Implement the widget")
    );
    expect(result.success).toBe(true);
    expect(result.prompt).toBe("Step 1: do X");
    expect(result.error).toBeUndefined();
  });

  it("includes task metadata in the prompt sent to the provider", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("plan output"),
    });

    const agent = await boot({ cwd: "/workspace", provider });
    await agent.plan(TASK_FIXTURE);

    const promptArg = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(promptArg).toContain("/workspace");
    expect(promptArg).toContain(TASK_FIXTURE.file);
    expect(promptArg).toContain(`line ${TASK_FIXTURE.line}`);
    expect(promptArg).toContain(TASK_FIXTURE.text);
  });

  it("includes file context in the prompt when provided", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("plan output"),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    await agent.plan(TASK_FIXTURE, "# Heading\nSome context about the task");

    const promptArg = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(promptArg).toContain("Task File Contents");
    expect(promptArg).toContain("# Heading\nSome context about the task");
  });

  it("does not include file context section when fileContext is not provided", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("plan output"),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    await agent.plan(TASK_FIXTURE);

    const promptArg = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(promptArg).not.toContain("Task File Contents");
  });

  it("returns failure when provider returns empty string", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(""),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(result.success).toBe(false);
    expect(result.prompt).toBe("");
    expect(result.error).toBe("Planner returned empty plan");
  });

  it("returns failure when provider returns whitespace-only string", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("   \n  \t  "),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(result.success).toBe(false);
    expect(result.prompt).toBe("");
    expect(result.error).toBe("Planner returned empty plan");
  });

  it("returns failure when provider returns null", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(null),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(result.success).toBe(false);
    expect(result.prompt).toBe("");
    expect(result.error).toBe("Planner returned empty plan");
  });

  it("catches provider exceptions and returns failure", async () => {
    const provider = createMockProvider({
      createSession: vi.fn<ProviderInstance["createSession"]>().mockRejectedValue(
        new Error("Connection refused")
      ),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(result.success).toBe(false);
    expect(result.prompt).toBe("");
    expect(result.error).toBe("Connection refused");
  });

  it("catches prompt exceptions and returns failure", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockRejectedValue(
        new Error("Timeout exceeded")
      ),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(result.success).toBe(false);
    expect(result.prompt).toBe("");
    expect(result.error).toBe("Timeout exceeded");
  });

  it("handles non-Error exceptions", async () => {
    const provider = createMockProvider({
      createSession: vi.fn<ProviderInstance["createSession"]>().mockRejectedValue(
        "raw string error"
      ),
    });

    const agent = await boot({ cwd: "/tmp/test", provider });
    const result = await agent.plan(TASK_FIXTURE);

    expect(result.success).toBe(false);
    expect(result.error).toBe("raw string error");
  });

  it("uses cwd override in prompt when provided", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("plan output"),
    });

    const agent = await boot({ cwd: "/original", provider });
    await agent.plan(TASK_FIXTURE, undefined, "/worktree/path");

    const promptArg = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(promptArg).toContain("/worktree/path");
    expect(promptArg).not.toContain("/original");
  });

  it("falls back to boot-time cwd when cwd override is not provided", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("plan output"),
    });

    const agent = await boot({ cwd: "/boot-cwd", provider });
    await agent.plan(TASK_FIXTURE);

    const promptArg = vi.mocked(provider.prompt).mock.calls[0][1];
    expect(promptArg).toContain("/boot-cwd");
  });
});

describe("cleanup", () => {
  it("resolves without error", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });
});
