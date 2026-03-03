import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock references ────────────────────────────────────────

const { mockCreateSession, mockSession } = vi.hoisted(() => {
  const mockSession = {
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn().mockReturnValue((async function* () {})()),
    close: vi.fn(),
  };

  const mockCreateSession = vi.fn().mockReturnValue(mockSession);

  return { mockCreateSession, mockSession };
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

import { boot } from "../providers/claude.js";
import { randomUUID } from "node:crypto";

// ─── Reset mocks between tests ─────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRandomUUID.mockReturnValue("test-uuid-1234");
  mockCreateSession.mockReturnValue(mockSession);
  mockSession.send.mockResolvedValue(undefined);
  mockSession.stream.mockReturnValue((async function* () {})());
  mockSession.close.mockReturnValue(undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────

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
    expect(mockCreateSession).toHaveBeenCalledWith({ model: "claude-sonnet-4", permissionMode: "acceptEdits" });
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

  it("returns null when no assistant message found", async () => {
    mockSession.stream.mockReturnValue((async function* () {})());

    const instance = await boot();
    const sessionId = await instance.createSession();
    const result = await instance.prompt(sessionId, "hello");
    expect(result).toBeNull();
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
