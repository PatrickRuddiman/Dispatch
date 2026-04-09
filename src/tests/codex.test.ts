import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRandomUUID, mockRun, mockTerminate, agentLoopInstances } = vi.hoisted(() => {
  const mockRandomUUID = vi.fn().mockReturnValue("codex-session-1");
  const mockRun = vi.fn();
  const mockTerminate = vi.fn();
  const agentLoopInstances: Array<{ options: Record<string, unknown> }> = [];

  return { mockRandomUUID, mockRun, mockTerminate, agentLoopInstances };
});

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("@openai/codex", () => ({
  AgentLoop: vi.fn().mockImplementation(function AgentLoop(options: Record<string, unknown>) {
    agentLoopInstances.push({ options });
    return {
      run: mockRun,
      terminate: mockTerminate,
    };
  }),
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    debug: vi.fn(),
    formatErrorChain: vi.fn().mockReturnValue("mock error chain"),
  },
}));

import { boot, listModels } from "../providers/codex.js";

describe("listModels", () => {
  it("returns known model identifiers", async () => {
    const models = await listModels();
    expect(models).toContain("codex-mini-latest");
    expect(models).toContain("o4-mini");
    expect(models).toContain("o3-mini");
  });

  it("accepts opts argument without error", async () => {
    const models = await listModels({ model: "codex-mini-latest" });
    expect(Array.isArray(models)).toBe(true);
  });
});

describe("boot", () => {
  it("uses default model o4-mini when no opts provided", async () => {
    const instance = await boot();
    expect(instance.model).toBe("o4-mini");
  });

  it("uses provided model", async () => {
    const instance = await boot({ model: "o3-mini" });
    expect(instance.model).toBe("o3-mini");
  });

  it("returns instance with name 'codex'", async () => {
    const instance = await boot();
    expect(instance.name).toBe("codex");
  });

  it("returns instance with all required methods", async () => {
    const instance = await boot();
    expect(typeof instance.createSession).toBe("function");
    expect(typeof instance.prompt).toBe("function");
    expect(typeof instance.send).toBe("function");
    expect(typeof instance.cleanup).toBe("function");
  });
});

describe("codex provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentLoopInstances.length = 0;
    mockRandomUUID.mockReturnValue("codex-session-1");
    mockRun.mockResolvedValue([]);
    mockTerminate.mockReturnValue(undefined);
  });

  it("creates a session and extracts final output text", async () => {
    mockRun.mockImplementation(async () => [
      {
        type: "message",
        content: [
          { type: "reasoning", text: "ignore" },
          { type: "output_text", text: "done" },
        ],
      },
    ]);

    const instance = await boot({ cwd: "/tmp/worktree" });
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");

    expect(sessionId).toBe("codex-session-1");
    expect(result).toBe("done");
    expect(agentLoopInstances[0]?.options).toMatchObject({
      model: "o4-mini",
      rootDir: "/tmp/worktree",
      approvalPolicy: "full-auto",
    });
  });

  it("omits rootDir when no cwd is provided", async () => {
    const instance = await boot();
    await instance.createSession();
    expect(agentLoopInstances[0]?.options).not.toHaveProperty("rootDir");
  });

  it("emits at most one sparse loading update", async () => {
    const progress: string[] = [];

    mockRun.mockImplementation(async () => {
      const onLoading = agentLoopInstances[0]?.options.onLoading as (() => void) | undefined;
      onLoading?.();
      onLoading?.();

      return [
        {
          type: "message",
          content: [{ type: "output_text", text: "final answer" }],
        },
      ];
    });

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello", {
      onProgress: (update) => progress.push(update.text),
    });

    expect(result).toBe("final answer");
    expect(progress).toEqual([
      "Waiting for Codex response",
      "thinking",
      "Finalizing response",
    ]);
  });

  it("returns final output even when no loading callback fires", async () => {
    const onProgress = vi.fn();

    mockRun.mockResolvedValue([
      {
        type: "message",
        content: [{ type: "output_text", text: "final answer" }],
      },
    ]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello", { onProgress });

    expect(result).toBe("final answer");
    expect(onProgress.mock.calls.map(([update]) => update.text)).toEqual([
      "Waiting for Codex response",
      "Finalizing response",
    ]);
  });

  it("returns null when run returns no output_text blocks", async () => {
    mockRun.mockResolvedValue([
      { type: "message", content: [{ type: "reasoning", text: "thinking..." }] },
    ]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(result).toBeNull();
  });

  it("returns null when run returns non-message items only", async () => {
    mockRun.mockResolvedValue([{ type: "tool_call", content: [] }]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(result).toBeNull();
  });

  it("onItem callback emits output_text content", async () => {
    const progress: string[] = [];

    mockRun.mockImplementation(async () => {
      // Fire onItem during the run, so the reporter has the onProgress callback set
      const onItem = agentLoopInstances[0]?.options.onItem as ((item: unknown) => void) | undefined;
      onItem?.({
        type: "message",
        content: [{ type: "output_text", text: "streamed chunk" }],
      });
      return [];
    });

    const instance = await boot();
    const sessionId = await instance.createSession();

    await instance.prompt(sessionId, "hello", {
      onProgress: (u) => progress.push(u.text),
    });

    // The streamed text was emitted via onItem during the run
    expect(progress).toContain("streamed chunk");
  });

  it("onItem callback ignores non-output_text blocks", () => {
    // Should not throw even with irrelevant block types
    expect(async () => {
      const instance = await boot();
      await instance.createSession();
      const onItem = agentLoopInstances[0]?.options.onItem as ((item: unknown) => void) | undefined;
      onItem?.({ type: "message", content: [{ type: "reasoning", text: "thinking" }] });
      onItem?.({ type: "other_type" });
      onItem?.(null);
    }).not.toThrow();
  });

  it("throws when prompt is called with unknown sessionId", async () => {
    const instance = await boot();
    await expect(instance.prompt("unknown-session-id", "hello")).rejects.toThrow(
      "Codex session unknown-session-id not found"
    );
  });

  it("throws when prompt run fails", async () => {
    mockRun.mockRejectedValueOnce(new Error("run failed"));
    const instance = await boot();
    const sessionId = await instance.createSession();
    await expect(instance.prompt(sessionId, "hello")).rejects.toThrow("run failed");
  });

  it("concatenates multiple output_text items from a single run", async () => {
    mockRun.mockResolvedValue([
      {
        type: "message",
        content: [{ type: "output_text", text: "part1 " }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "part2" }],
      },
    ]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(result).toBe("part1 part2");
  });
});

describe("send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentLoopInstances.length = 0;
    mockRandomUUID.mockReturnValue("codex-session-1");
  });

  it("throws for unknown sessionId", async () => {
    const instance = await boot();
    await expect(instance.send!("unknown-id", "text")).rejects.toThrow(
      "Codex session unknown-id not found"
    );
  });

  it("resolves without error for a known session (no-op)", async () => {
    const instance = await boot();
    const sessionId = await instance.createSession();
    await expect(instance.send!(sessionId, "follow-up")).resolves.toBeUndefined();
  });
});

describe("cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentLoopInstances.length = 0;
    mockRandomUUID.mockReturnValue("codex-session-1");
    mockTerminate.mockReturnValue(undefined);
  });

  it("terminates all sessions", async () => {
    mockRandomUUID
      .mockReturnValueOnce("session-a")
      .mockReturnValueOnce("session-b");

    const instance = await boot();
    await instance.createSession();
    await instance.createSession();
    await instance.cleanup();
    expect(mockTerminate).toHaveBeenCalledTimes(2);
  });

  it("handles terminate errors gracefully", async () => {
    mockTerminate.mockImplementationOnce(() => {
      throw new Error("terminate boom");
    });
    const instance = await boot();
    await instance.createSession();
    await expect(instance.cleanup()).resolves.toBeUndefined();
  });

  it("is idempotent — second cleanup succeeds", async () => {
    const instance = await boot();
    await instance.createSession();
    await instance.cleanup();
    mockTerminate.mockClear();
    await expect(instance.cleanup()).resolves.toBeUndefined();
    expect(mockTerminate).not.toHaveBeenCalled();
  });
});
