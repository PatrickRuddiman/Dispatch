import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

// ─── mocks ───────────────────────────────────────────────────────────

const { mockMkdirSync, mockWriteFileSync, mockAppendFileSync } = vi.hoisted(
  () => ({
    mockMkdirSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockAppendFileSync: vi.fn(),
  }),
);

vi.mock("node:fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  appendFileSync: mockAppendFileSync,
}));

import { FileLogger, fileLoggerStorage } from "../helpers/file-logger.js";

// ─── fixtures ────────────────────────────────────────────────────────

const FAKE_CWD = "/fake/project";
const FIXED_ISO = "2024-01-15T10:30:45.123Z";

beforeEach(() => {
  mockMkdirSync.mockReset();
  mockWriteFileSync.mockReset();
  mockAppendFileSync.mockReset();
  vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── constructor ─────────────────────────────────────────────────────

describe("constructor", () => {
  it("creates the log directory with recursive option", () => {
    new FileLogger("42", FAKE_CWD);
    expect(mockMkdirSync).toHaveBeenCalledOnce();
    expect(mockMkdirSync.mock.calls[0][0]).toContain(
      join(".dispatch", "logs"),
    );
    expect(mockMkdirSync.mock.calls[0][1]).toEqual({ recursive: true });
  });

  it("truncates the log file on creation", () => {
    new FileLogger("42", FAKE_CWD);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(FAKE_CWD, ".dispatch", "logs", "issue-42.log"),
      "",
      "utf-8",
    );
  });

  it("sets the correct file path", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    expect(logger.filePath).toBe(
      join(FAKE_CWD, ".dispatch", "logs", "issue-42.log"),
    );
  });

  it("accepts numeric issue IDs", () => {
    const logger = new FileLogger(99, FAKE_CWD);
    expect(logger.filePath).toContain("issue-99.log");
  });

  it("truncates on each new instance (new run)", () => {
    new FileLogger("42", FAKE_CWD);
    new FileLogger("42", FAKE_CWD);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
  });
});

// ─── timestamped output format ───────────────────────────────────────

describe("timestamped output format", () => {
  it("prefixes every line with ISO 8601 timestamp", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("hello");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toMatch(/^\[2024-01-15T10:30:45\.123Z\]/);
  });

  it("includes the level tag after the timestamp", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.warn("test");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[2024-01-15T10:30:45.123Z] [WARN]");
  });

  it("ends each entry with a newline", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("msg");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toMatch(/\n$/);
  });
});

// ─── append behavior ─────────────────────────────────────────────────

describe("append behavior", () => {
  it("appends each write via appendFileSync", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("first");
    logger.info("second");
    expect(mockAppendFileSync).toHaveBeenCalledTimes(2);
  });

  it("writes to the correct file path", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("test");
    expect(mockAppendFileSync.mock.calls[0][0]).toBe(logger.filePath);
  });

  it("uses utf-8 encoding", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("test");
    expect(mockAppendFileSync.mock.calls[0][2]).toBe("utf-8");
  });
});

// ─── log methods ─────────────────────────────────────────────────────

describe("log methods", () => {
  it("info writes with INFO level", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("info msg");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[INFO] info msg");
  });

  it("debug writes with DEBUG level", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.debug("debug msg");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[DEBUG] debug msg");
  });

  it("warn writes with WARN level", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.warn("warn msg");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[WARN] warn msg");
  });

  it("error writes with ERROR level", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.error("error msg");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[ERROR] error msg");
  });

  it("prompt writes with PROMPT level and formatted content", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.prompt("planner", "the prompt text");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[PROMPT]");
    expect(written).toContain("planner");
    expect(written).toContain("the prompt text");
    expect(written).toContain("─".repeat(40));
  });

  it("response writes with RESPONSE level and formatted content", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.response("planner", "the response text");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[RESPONSE]");
    expect(written).toContain("planner");
    expect(written).toContain("the response text");
    expect(written).toContain("─".repeat(40));
  });

  it("phase writes with PHASE level and banner", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.phase("planning");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[PHASE]");
    expect(written).toContain("planning");
    expect(written).toContain("═".repeat(40));
  });

  it("skillEvent writes with SKILL level", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.skillEvent("executor", "started", "issue 42");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[SKILL] [executor] started: issue 42");
  });

  it("skillEvent omits detail when not provided", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.skillEvent("executor", "finished");
    const written = mockAppendFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[SKILL] [executor] finished");
    expect(written).not.toMatch(/\[AGENT\] \[executor\] finished:/);
  });
});

// ─── AsyncLocalStorage context scoping ───────────────────────────────

describe("AsyncLocalStorage context scoping", () => {
  it("stores and retrieves the correct logger within a context", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    fileLoggerStorage.run(logger, () => {
      expect(fileLoggerStorage.getStore()).toBe(logger);
    });
  });

  it("returns undefined outside of a context", () => {
    expect(fileLoggerStorage.getStore()).toBeUndefined();
  });

  it("scopes different loggers to different async contexts", () => {
    const loggerA = new FileLogger("1", FAKE_CWD);
    const loggerB = new FileLogger("2", FAKE_CWD);
    fileLoggerStorage.run(loggerA, () => {
      expect(fileLoggerStorage.getStore()).toBe(loggerA);
      fileLoggerStorage.run(loggerB, () => {
        expect(fileLoggerStorage.getStore()).toBe(loggerB);
      });
      expect(fileLoggerStorage.getStore()).toBe(loggerA);
    });
  });
});

// ─── plain text output ───────────────────────────────────────────────

describe("plain text output", () => {
  it("does not contain ANSI escape codes", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    logger.info("info");
    logger.debug("debug");
    logger.warn("warn");
    logger.error("error");
    logger.prompt("label", "content");
    logger.response("label", "content");
    logger.phase("phase");
    logger.skillEvent("skill", "event", "detail");

    for (const call of mockAppendFileSync.mock.calls) {
      const written = call[1] as string;
      expect(written).not.toMatch(/\x1b\[/);
    }
  });
});

// ─── close ───────────────────────────────────────────────────────────

describe("close", () => {
  it("does not throw", () => {
    const logger = new FileLogger("42", FAKE_CWD);
    expect(() => logger.close()).not.toThrow();
  });
});
