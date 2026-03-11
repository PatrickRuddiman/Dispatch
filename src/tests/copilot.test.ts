import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock references ────────────────────────────────────────

const { mockClient, mockSession } = vi.hoisted(() => {
  const mockSession = {
    sessionId: "test-session-1",
    rpc: {
      model: {
        getCurrent: vi
          .fn()
          .mockResolvedValue({ modelId: "test-provider/test-model" }),
      },
    },
    send: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  const mockClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue(mockSession),
  };

  return { mockClient, mockSession };
});

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
  approveAll: vi.fn(),
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    debug: vi.fn(),
    formatErrorChain: vi.fn().mockReturnValue("mock error chain"),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

import { boot } from "../providers/copilot.js";
import { TimeoutError } from "../helpers/timeout.js";
import { CopilotClient } from "@github/copilot-sdk";
import { log } from "../helpers/logger.js";

// ─── Reset mocks between tests ─────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.start.mockResolvedValue(undefined);
  mockClient.stop.mockResolvedValue([]);
  mockClient.createSession.mockResolvedValue(mockSession);
  mockSession.rpc.model.getCurrent.mockResolvedValue({
    modelId: "test-provider/test-model",
  });
  mockSession.send.mockResolvedValue(undefined);
  mockSession.getMessages.mockResolvedValue([]);
  mockSession.destroy.mockResolvedValue(undefined);
  mockSession.on.mockReturnValue(vi.fn());
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("boot", () => {
  it("creates CopilotClient without cliUrl when no opts provided", async () => {
    await boot();
    expect(CopilotClient).toHaveBeenCalledWith({});
  });

  it("creates CopilotClient with cliUrl when opts.url provided", async () => {
    await boot({ url: "http://localhost:3000" });
    expect(CopilotClient).toHaveBeenCalledWith({
      cliUrl: "http://localhost:3000",
    });
  });

  it("calls client.start()", async () => {
    await boot();
    expect(mockClient.start).toHaveBeenCalledOnce();
  });

  it("passes cwd to CopilotClient when opts.cwd provided", async () => {
    await boot({ cwd: "/tmp/worktree" });
    expect(CopilotClient).toHaveBeenCalledWith({
      cwd: "/tmp/worktree",
    });
  });

  it("passes both cliUrl and cwd to CopilotClient when both provided", async () => {
    await boot({ url: "http://localhost:3000", cwd: "/tmp/worktree" });
    expect(CopilotClient).toHaveBeenCalledWith({
      cliUrl: "http://localhost:3000",
      cwd: "/tmp/worktree",
    });
  });

  it("throws when client.start() fails", async () => {
    mockClient.start.mockRejectedValueOnce(new Error("start failed"));
    await expect(boot()).rejects.toThrow("start failed");
  });

  it("returns a ProviderInstance with correct shape", async () => {
    const instance = await boot();
    expect(instance.name).toBe("copilot");
    expect(instance.model).toBeUndefined();
    expect(typeof instance.createSession).toBe("function");
    expect(typeof instance.prompt).toBe("function");
    expect(typeof instance.cleanup).toBe("function");
  });
});

describe("createSession", () => {
  it("creates a session and returns sessionId", async () => {
    const instance = await boot();
    const sessionId = await instance.createSession();
    expect(sessionId).toBe("test-session-1");
    expect(mockClient.createSession).toHaveBeenCalledWith({
      onPermissionRequest: expect.any(Function),
    });
  });

  it("passes workingDirectory to createSession when opts.cwd provided", async () => {
    const instance = await boot({ cwd: "/tmp/worktree" });
    await instance.createSession();
    expect(mockClient.createSession).toHaveBeenCalledWith({
      workingDirectory: "/tmp/worktree",
      onPermissionRequest: expect.any(Function),
    });
  });

  it("detects model on first session creation", async () => {
    const instance = await boot();
    await instance.createSession();
    expect(instance.model).toBe("test-provider/test-model");
  });

  it("only detects model once", async () => {
    const instance = await boot();
    await instance.createSession();
    mockSession.rpc.model.getCurrent.mockClear();
    await instance.createSession();
    expect(mockSession.rpc.model.getCurrent).not.toHaveBeenCalled();
  });

  it("swallows model detection errors", async () => {
    mockSession.rpc.model.getCurrent.mockRejectedValueOnce(
      new Error("nope"),
    );
    const instance = await boot();
    await expect(instance.createSession()).resolves.toBe("test-session-1");
    expect(instance.model).toBeUndefined();
  });

  it("throws when client.createSession() fails", async () => {
    mockClient.createSession.mockRejectedValueOnce(
      new Error("session fail"),
    );
    const instance = await boot();
    await expect(instance.createSession()).rejects.toThrow("session fail");
  });
});

describe("prompt", () => {
  it("throws when session not found", async () => {
    const instance = await boot();
    await expect(instance.prompt("unknown-id", "hello")).rejects.toThrow(
      "Copilot session unknown-id not found",
    );
  });

  it("sends prompt and returns assistant message", async () => {
    mockSession.on.mockImplementation(
      (eventName: string, handler: Function) => {
        if (eventName === "session.idle") {
          setTimeout(() => handler(), 0);
        }
        return vi.fn();
      },
    );
    mockSession.getMessages.mockResolvedValue([
      {
        type: "assistant.message",
        data: { content: "response text" },
      },
    ]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(mockSession.send).toHaveBeenCalledWith({ prompt: "hello" });
    expect(result).toBe("response text");
  });

    it("emits sparse lifecycle progress snapshots", async () => {
      const onProgress = vi.fn();
      const unsubIdle = vi.fn();
      const unsubErr = vi.fn();

    mockSession.on.mockImplementation(
      (eventName: string, handler: Function) => {
        if (eventName === "session.idle") {
          setTimeout(() => handler(), 0);
          return unsubIdle;
        }

        return unsubErr;
      },
    );
    mockSession.getMessages.mockResolvedValue([
      {
        type: "assistant.message",
        data: { content: "response text" },
      },
    ]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello", { onProgress });

      expect(result).toBe("response text");
      expect(onProgress).toHaveBeenCalledWith({ text: "Waiting for Copilot response" });
      expect(onProgress).toHaveBeenCalledWith({ text: "Finalizing response" });
      expect(onProgress.mock.calls.map(([update]) => update.text)).toEqual([
        "Waiting for Copilot response",
        "Finalizing response",
      ]);
      expect(unsubIdle).toHaveBeenCalled();
      expect(unsubErr).toHaveBeenCalled();
    });

  it("returns null when no assistant message found", async () => {
    mockSession.on.mockImplementation(
      (eventName: string, handler: Function) => {
        if (eventName === "session.idle") {
          setTimeout(() => handler(), 0);
        }
        return vi.fn();
      },
    );
    mockSession.getMessages.mockResolvedValue([]);

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(result).toBeNull();
  });

  it("throws on session.error event", async () => {
    mockSession.on.mockImplementation(
      (eventName: string, handler: Function) => {
        if (eventName === "session.error") {
          setTimeout(
            () => handler({ data: { message: "session boom" } }),
            0,
          );
        }
        return vi.fn();
      },
    );

    const instance = await boot();
    const sessionId = await instance.createSession();
    await expect(instance.prompt(sessionId, "hello")).rejects.toThrow(
      "Copilot session error: session boom",
    );
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with TimeoutError when neither idle nor error fires within 10 minutes", async () => {
      const unsubIdle = vi.fn();
      const unsubErr = vi.fn();
      mockSession.on.mockImplementation((eventName: string) => {
        return eventName === "session.idle" ? unsubIdle : unsubErr;
      });

      const instance = await boot();
      const sessionId = await instance.createSession();
      const resultPromise = instance.prompt(sessionId, "hello");
      // Prevent unhandled rejection warning during timer advancement
      resultPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(600_000);

      await expect(resultPromise).rejects.toBeInstanceOf(TimeoutError);
      await expect(resultPromise).rejects.toThrow("copilot session ready");
    });

    it("calls both unsubscribe functions on timeout", async () => {
      const unsubIdle = vi.fn();
      const unsubErr = vi.fn();
      mockSession.on.mockImplementation((eventName: string) => {
        return eventName === "session.idle" ? unsubIdle : unsubErr;
      });

      const instance = await boot();
      const sessionId = await instance.createSession();
      const resultPromise = instance.prompt(sessionId, "hello");
      // Prevent unhandled rejection warning during timer advancement
      resultPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(600_000);

      // Let the rejection settle
      await resultPromise.catch(() => {});

      expect(unsubIdle).toHaveBeenCalled();
      expect(unsubErr).toHaveBeenCalled();
    });
  });
});

describe("cleanup", () => {
  it("destroys all sessions and stops client", async () => {
    const instance = await boot();
    await instance.createSession();
    await instance.cleanup();
    expect(mockSession.destroy).toHaveBeenCalled();
    expect(mockClient.stop).toHaveBeenCalled();
  });

  it("handles destroy errors gracefully", async () => {
    mockSession.destroy.mockRejectedValueOnce(new Error("destroy fail"));
    const instance = await boot();
    await instance.createSession();
    await expect(instance.cleanup()).resolves.not.toThrow();
    expect(log.debug).toHaveBeenCalledWith(
      "Failed to destroy Copilot session: mock error chain",
    );
  });

  it("handles stop errors gracefully", async () => {
    mockClient.stop.mockRejectedValueOnce(new Error("stop fail"));
    const instance = await boot();
    await expect(instance.cleanup()).resolves.not.toThrow();
    expect(log.debug).toHaveBeenCalledWith(
      "Failed to stop Copilot client: mock error chain",
    );
  });
});
