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

import { boot } from "../providers/codex.js";

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
});
