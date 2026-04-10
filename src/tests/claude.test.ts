import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock references ────────────────────────────────────────

const { mockQuery, mockQueryFn, mockCreateSession, mockSession } = vi.hoisted(() => {
  const mockQuery = {
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  };

  const mockQueryFn = vi.fn().mockReturnValue(mockQuery);

  const mockSession = {
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn().mockReturnValue((async function* () {})()),
    close: vi.fn(),
  };

  const mockCreateSession = vi.fn().mockReturnValue(mockSession);

  return { mockQuery, mockQueryFn, mockCreateSession, mockSession };
});

const { mockRandomUUID } = vi.hoisted(() => {
  const mockRandomUUID = vi.fn().mockReturnValue("test-uuid-1234");
  return { mockRandomUUID };
});

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
  unstable_v2_createSession: mockCreateSession,
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("test-uuid-1234"),
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    debug: vi.fn(),
    formatErrorChain: vi.fn().mockReturnValue("mock error chain"),
  },
}));

import { boot, listModels } from "../providers/claude.js";
import { randomUUID } from "node:crypto";

// ─── Reset mocks between tests ─────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRandomUUID.mockReturnValue("test-uuid-1234");
  mockQueryFn.mockReturnValue(mockQuery);
  mockQuery.supportedModels.mockResolvedValue([]);
  mockQuery.close.mockReturnValue(undefined);
  mockCreateSession.mockReturnValue(mockSession);
  mockSession.send.mockResolvedValue(undefined);
  mockSession.stream.mockReturnValue((async function* () {})());
  mockSession.close.mockReturnValue(undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("listModels", () => {
  it("returns sorted model values from supportedModels()", async () => {
    mockQuery.supportedModels.mockResolvedValue([
      { value: "claude-sonnet-4", displayName: "Sonnet 4", description: "" },
      { value: "claude-haiku-3-5", displayName: "Haiku 3.5", description: "" },
      { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "" },
    ]);

    const models = await listModels();
    expect(models).toEqual(["claude-haiku-3-5", "claude-opus-4-6", "claude-sonnet-4"]);
    expect(mockQuery.close).toHaveBeenCalled();
  });

  it("closes the query even when supportedModels() throws", async () => {
    mockQuery.supportedModels.mockRejectedValue(new Error("fetch fail"));

    const models = await listModels();
    expect(mockQuery.close).toHaveBeenCalled();
    // Falls back to empty list
    expect(models).toEqual([]);
  });

  it("falls back to empty list when query() throws", async () => {
    mockQueryFn.mockImplementation(() => {
      throw new Error("query fail");
    });

    const models = await listModels();
    expect(models).toEqual([]);
  });
});

describe("boot", () => {
  it("uses default model when no opts provided", async () => {
    const instance = await boot();
    expect(instance.model).toBe("claude-sonnet-4");
  });

  it("uses provided model when opts.model is set", async () => {
    const instance = await boot({ model: "claude-opus-4-6" });
    expect(instance.model).toBe("claude-opus-4-6");
  });

  it("returns a ProviderInstance with correct shape", async () => {
    const instance = await boot();
    expect(instance.name).toBe("claude");
    expect(instance.model).toBe("claude-sonnet-4");
    expect(typeof instance.createSession).toBe("function");
    expect(typeof instance.prompt).toBe("function");
    expect(typeof instance.cleanup).toBe("function");
  });
});

describe("createSession", () => {
  it("creates a session and returns sessionId", async () => {
    const instance = await boot();
    const sessionId = await instance.createSession();
    expect(sessionId).toBe("test-uuid-1234");
    expect(mockCreateSession).toHaveBeenCalledWith({ model: "claude-sonnet-4", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
  });

  it("passes cwd to unstable_v2_createSession when opts.cwd is set", async () => {
    const instance = await boot({ cwd: "/tmp/worktree" });
    await instance.createSession();
    expect(mockCreateSession).toHaveBeenCalledWith({
      model: "claude-sonnet-4",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: "/tmp/worktree",
    });
  });

  it("omits cwd from session options when opts.cwd is not set", async () => {
    const instance = await boot({ model: "claude-opus-4-6" });
    await instance.createSession();
    expect(mockCreateSession).toHaveBeenCalledWith({
      model: "claude-opus-4-6",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it("throws when unstable_v2_createSession fails", async () => {
    mockCreateSession.mockImplementation(() => {
      throw new Error("session fail");
    });
    const instance = await boot();
    await expect(instance.createSession()).rejects.toThrow("session fail");
  });
});

describe("prompt", () => {
  it("throws when session not found", async () => {
    const instance = await boot();
    await expect(instance.prompt("unknown-id", "hello")).rejects.toThrow(
      "Claude session unknown-id not found",
    );
  });

  it("sends prompt and returns assistant message text", async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "response text" }],
          },
        };
      })(),
    );

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(mockSession.send).toHaveBeenCalledWith("hello");
    expect(result).toBe("response text");
  });

  it("emits sanitized assistant stream progress", async () => {
    const progress: string[] = [];

    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "\n\n" }],
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "draft\nplan" }],
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "draft plan" }],
          },
        };
      })(),
    );

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello", {
      onProgress: (update) => progress.push(update.text),
    });

    expect(result).toBe("\n\ndraft\nplandraft plan");
    expect(progress).toEqual(["draft plan"]);
  });

  it("emits progress snapshots from assistant stream output", async () => {
    const onProgress = vi.fn();

    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "streamed response text" }],
          },
        };
      })(),
    );

    const instance = await boot();
    const sessionId = await instance.createSession();
    await instance.prompt(sessionId, "hello", { onProgress });

    expect(onProgress).toHaveBeenCalledWith({ text: "streamed response text" });
  });

  it("throws when no assistant message found", async () => {
    mockSession.stream.mockReturnValue((async function* () {})());

    const instance = await boot();
    const sessionId = await instance.createSession();
    await expect(instance.prompt(sessionId, "hello")).rejects.toThrow(
      "Claude stream ended before receiving an assistant message",
    );
  });

  it("throws when session.send fails", async () => {
    mockSession.send.mockRejectedValueOnce(new Error("send boom"));

    const instance = await boot();
    const sessionId = await instance.createSession();
    await expect(instance.prompt(sessionId, "hello")).rejects.toThrow("send boom");
  });
});

describe("cleanup", () => {
  it("closes all sessions and clears them", async () => {
    const instance = await boot();
    await instance.createSession();
    await instance.cleanup();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it("handles close errors gracefully", async () => {
    mockSession.close.mockImplementation(() => {
      throw new Error("close fail");
    });
    const instance = await boot();
    await instance.createSession();
    await expect(instance.cleanup()).resolves.not.toThrow();
  });

  it("is idempotent — second cleanup does not throw", async () => {
    const instance = await boot();
    await instance.createSession();
    await instance.cleanup();
    mockSession.close.mockClear();
    await expect(instance.cleanup()).resolves.not.toThrow();
    expect(mockSession.close).not.toHaveBeenCalled();
  });
});

describe("send", () => {
  it("throws when session not found", async () => {
    const instance = await boot();
    await expect(instance.send!("unknown-id", "hello")).rejects.toThrow(
      "Claude session unknown-id not found",
    );
  });

  it("sends follow-up text to the session", async () => {
    const instance = await boot();
    const sessionId = await instance.createSession();
    await instance.send!(sessionId, "follow-up text");
    expect(mockSession.send).toHaveBeenCalledWith("follow-up text");
  });

  it("throws when session.send fails during send", async () => {
    mockSession.send.mockRejectedValueOnce(new Error("send follow-up boom"));
    const instance = await boot();
    const sessionId = await instance.createSession();
    await expect(instance.send!(sessionId, "text")).rejects.toThrow("send follow-up boom");
  });
});
