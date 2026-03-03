import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mocks } = vi.hoisted(() => {
  const mockConfigGet = vi.fn();
  const mockSessionCreate = vi.fn();
  const mockSessionPromptAsync = vi.fn();
  const mockEventSubscribe = vi.fn();
  const mockSessionMessages = vi.fn();
  const mockServerClose = vi.fn();
  const mockCreateOpencode = vi.fn();
  const mockCreateOpencodeClient = vi.fn();

  return {
    mocks: {
      mockConfigGet,
      mockSessionCreate,
      mockSessionPromptAsync,
      mockEventSubscribe,
      mockSessionMessages,
      mockServerClose,
      mockCreateOpencode,
      mockCreateOpencodeClient,
    },
  };
});

// ── Module mocks ───────────────────────────────────────────────────
vi.mock("@opencode-ai/sdk", () => ({
  createOpencode: mocks.mockCreateOpencode,
  createOpencodeClient: mocks.mockCreateOpencodeClient,
}));

vi.mock("../helpers/logger.js", () => ({
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
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

// ── Import under test ──────────────────────────────────────────────
import { boot } from "../providers/opencode.js";
import { log } from "../helpers/logger.js";

// ── Helpers ────────────────────────────────────────────────────────
function createMockClient() {
  return {
    config: { get: mocks.mockConfigGet },
    session: {
      create: mocks.mockSessionCreate,
      promptAsync: mocks.mockSessionPromptAsync,
      messages: mocks.mockSessionMessages,
    },
    event: { subscribe: mocks.mockEventSubscribe },
  };
}

async function* arrayToAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// ── Tests ──────────────────────────────────────────────────────────
describe("opencode provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const client = createMockClient();
    mocks.mockCreateOpencodeClient.mockReturnValue(client);
    mocks.mockCreateOpencode.mockResolvedValue({
      client,
      server: { close: mocks.mockServerClose },
    });
    mocks.mockConfigGet.mockResolvedValue({
      data: { model: "anthropic/claude-sonnet-4" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── boot ─────────────────────────────────────────────────────
  describe("boot", () => {
    it("connects to existing server when url is provided", async () => {
      const instance = await boot({ url: "http://localhost:1234" });
      expect(mocks.mockCreateOpencodeClient).toHaveBeenCalledWith({
        baseUrl: "http://localhost:1234",
      });
      expect(mocks.mockCreateOpencode).not.toHaveBeenCalled();
      expect(instance.name).toBe("opencode");
    });

    it("sets model from config when available", async () => {
      const instance = await boot({ url: "http://localhost:1234" });
      expect(instance.model).toBe("anthropic/claude-sonnet-4");
    });

    it("sets model to undefined when config fetch fails", async () => {
      mocks.mockConfigGet.mockRejectedValue(new Error("config error"));
      const instance = await boot({ url: "http://localhost:1234" });
      expect(instance.model).toBeUndefined();
    });

    it("sets model to undefined when config has no model", async () => {
      mocks.mockConfigGet.mockResolvedValue({ data: {} });
      const instance = await boot({ url: "http://localhost:1234" });
      expect(instance.model).toBeUndefined();
    });

    it("spawns local server when no url is provided", async () => {
      const instance = await boot();
      expect(mocks.mockCreateOpencode).toHaveBeenCalledWith({ port: 0 });
      expect(mocks.mockCreateOpencodeClient).not.toHaveBeenCalled();
      expect(instance.name).toBe("opencode");
    });

    it("logs cwd limitation when cwd is provided without url", async () => {
      const { log } = await import("../helpers/logger.js");
      await boot({ cwd: "/tmp/worktree" });
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining('Requested cwd "/tmp/worktree"'),
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining("does not support spawn-level cwd"),
      );
    });

    it("does not log cwd limitation when url is provided", async () => {
      const { log } = await import("../helpers/logger.js");
      await boot({ url: "http://localhost:1234", cwd: "/tmp/worktree" });
      expect(log.debug).not.toHaveBeenCalledWith(
        expect.stringContaining("does not support spawn-level cwd"),
      );
    });

    it("spawns local server normally when cwd is provided", async () => {
      const instance = await boot({ cwd: "/tmp/worktree" });
      expect(mocks.mockCreateOpencode).toHaveBeenCalledWith({ port: 0 });
      expect(instance.name).toBe("opencode");
    });

    it("throws when createOpencode fails", async () => {
      mocks.mockCreateOpencode.mockRejectedValue(new Error("spawn failed"));
      await expect(boot()).rejects.toThrow("spawn failed");
    });

    it("returns a ProviderInstance with expected properties", async () => {
      const instance = await boot({ url: "http://localhost:1234" });
      expect(instance.name).toBe("opencode");
      expect(typeof instance.model).toBe("string");
      expect(typeof instance.createSession).toBe("function");
      expect(typeof instance.prompt).toBe("function");
      expect(typeof instance.cleanup).toBe("function");
    });
  });

  // ── createSession ────────────────────────────────────────────
  describe("createSession", () => {
    it("returns session id on success", async () => {
      mocks.mockSessionCreate.mockResolvedValue({ data: { id: "sess-123" } });
      const instance = await boot({ url: "http://localhost:1234" });
      const id = await instance.createSession();
      expect(id).toBe("sess-123");
    });

    it("throws when session data is null", async () => {
      mocks.mockSessionCreate.mockResolvedValue({ data: null });
      const instance = await boot({ url: "http://localhost:1234" });
      await expect(instance.createSession()).rejects.toThrow(
        "Failed to create OpenCode session",
      );
    });

    it("throws when session.create rejects", async () => {
      mocks.mockSessionCreate.mockRejectedValue(new Error("network error"));
      const instance = await boot({ url: "http://localhost:1234" });
      await expect(instance.createSession()).rejects.toThrow("network error");
    });
  });

  // ── prompt ───────────────────────────────────────────────────
  describe("prompt", () => {
    it("returns assistant text on successful prompt", async () => {
      const events = [
        {
          type: "message.part.updated" as const,
          properties: {
            part: { type: "text", sessionID: "sess-1" },
            delta: "hello",
          },
        },
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [
          { info: { role: "user" as const }, parts: [] },
          {
            info: { role: "assistant" as const },
            parts: [{ type: "text" as const, text: "Result text" }],
          },
        ],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      const result = await instance.prompt("sess-1", "do something");
      expect(result).toBe("Result text");
    });

    it("throws when promptAsync returns an error", async () => {
      mocks.mockSessionPromptAsync.mockResolvedValue({
        error: { message: "bad request" },
      });

      const instance = await boot({ url: "http://localhost:1234" });
      await expect(instance.prompt("sess-1", "do something")).rejects.toThrow(
        "OpenCode promptAsync failed",
      );
    });

    it("throws on session.error event", async () => {
      const events = [
        {
          type: "session.error" as const,
          properties: { sessionID: "sess-1", error: "something broke" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });

      const instance = await boot({ url: "http://localhost:1234" });
      await expect(instance.prompt("sess-1", "do something")).rejects.toThrow(
        "OpenCode session error",
      );
    });

    it("skips events for other sessions", async () => {
      const events = [
        {
          type: "message.part.updated" as const,
          properties: {
            part: { type: "text", sessionID: "other-session" },
            delta: "ignore me",
          },
        },
        {
          type: "session.idle" as const,
          properties: { sessionID: "other-session" },
        },
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" as const },
            parts: [{ type: "text" as const, text: "Done" }],
          },
        ],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      const result = await instance.prompt("sess-1", "do something");
      expect(result).toBe("Done");
    });

    it("returns null when no messages are returned", async () => {
      const events = [
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({ data: [] });

      const instance = await boot({ url: "http://localhost:1234" });
      const result = await instance.prompt("sess-1", "do something");
      expect(result).toBeNull();
    });

    it("returns null when no assistant message exists", async () => {
      const events = [
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [{ info: { role: "user" as const }, parts: [] }],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      const result = await instance.prompt("sess-1", "do something");
      expect(result).toBeNull();
    });

    it("throws when assistant message has an error", async () => {
      const events = [
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" as const, error: "model failed" },
            parts: [{ type: "text" as const, text: "partial" }],
          },
        ],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      await expect(instance.prompt("sess-1", "do something")).rejects.toThrow(
        "OpenCode assistant error",
      );
    });

    it("aborts the SSE stream controller after processing", async () => {
      const events = [
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" as const },
            parts: [{ type: "text" as const, text: "ok" }],
          },
        ],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      await instance.prompt("sess-1", "test");

      // Verify event.subscribe was called with a signal
      expect(mocks.mockEventSubscribe).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("joins multiple text parts with newlines", async () => {
      const events = [
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" as const },
            parts: [
              { type: "text" as const, text: "line one" },
              { type: "text" as const, text: "line two" },
              { type: "text" as const, text: "line three" },
            ],
          },
        ],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      const result = await instance.prompt("sess-1", "do something");
      expect(result).toBe("line one\nline two\nline three");
    });

    it("returns null when assistant has no text parts", async () => {
      const events = [
        {
          type: "session.idle" as const,
          properties: { sessionID: "sess-1" },
        },
      ];

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockResolvedValue({
        stream: arrayToAsyncGenerator(events),
      });
      mocks.mockSessionMessages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" as const },
            parts: [{ type: "tool-invocation" as const }],
          },
        ],
      });

      const instance = await boot({ url: "http://localhost:1234" });
      const result = await instance.prompt("sess-1", "do something");
      expect(result).toBeNull();
    });

    it("cleans up AbortController when event.subscribe() throws synchronously", async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, "abort");

      mocks.mockSessionPromptAsync.mockResolvedValue({});
      mocks.mockEventSubscribe.mockRejectedValue(
        new Error("subscribe failed"),
      );

      const instance = await boot({ url: "http://localhost:1234" });
      await expect(instance.prompt("sess-1", "do something")).rejects.toThrow(
        "subscribe failed",
      );

      expect(abortSpy).toHaveBeenCalled();
      abortSpy.mockRestore();
    });
  });

  // ── cleanup ──────────────────────────────────────────────────
  describe("cleanup", () => {
    it("calls stopServer when spawned locally", async () => {
      const instance = await boot();
      await instance.cleanup();
      expect(mocks.mockServerClose).toHaveBeenCalledOnce();
    });

    it("is idempotent — second call is a no-op", async () => {
      const instance = await boot();
      await instance.cleanup();
      await instance.cleanup();
      expect(mocks.mockServerClose).toHaveBeenCalledTimes(1);
    });

    it("does not call stopServer when connected to existing server", async () => {
      const instance = await boot({ url: "http://localhost:1234" });
      await instance.cleanup();
      expect(mocks.mockServerClose).not.toHaveBeenCalled();
    });

    it("logs error at debug level when stopServer throws", async () => {
      mocks.mockServerClose.mockImplementation(() => {
        throw new Error("close failed");
      });
      const instance = await boot();
      await expect(instance.cleanup()).resolves.not.toThrow();
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining("close failed"),
      );
    });
  });
});
