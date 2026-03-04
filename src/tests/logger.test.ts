import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, getLogLevel } from "../helpers/logger.js";

describe("log", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.LOG_LEVEL;
    delete process.env.DEBUG;
    log.verbose = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── info ───────────────────────────────────────────────────────────

  describe("info", () => {
    it("prints the message to console.log", () => {
      log.info("hello");
      expect(logSpy).toHaveBeenCalledOnce();
      expect(logSpy.mock.calls[0][1]).toBe("hello");
    });

    it("prefixes with the info icon", () => {
      log.info("test");
      const prefix = logSpy.mock.calls[0][0] as string;
      expect(prefix).toContain("ℹ");
    });
  });

  // ─── success ────────────────────────────────────────────────────────

  describe("success", () => {
    it("prints the message to console.log", () => {
      log.success("done");
      expect(logSpy).toHaveBeenCalledOnce();
      expect(logSpy.mock.calls[0][1]).toBe("done");
    });

    it("prefixes with the success icon", () => {
      log.success("test");
      const prefix = logSpy.mock.calls[0][0] as string;
      expect(prefix).toContain("✔");
    });
  });

  // ─── warn ───────────────────────────────────────────────────────────

  describe("warn", () => {
    it("prints the message to console.error", () => {
      log.warn("careful");
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0][1]).toBe("careful");
    });

    it("prefixes with the warning icon", () => {
      log.warn("test");
      const prefix = errorSpy.mock.calls[0][0] as string;
      expect(prefix).toContain("⚠");
    });

    it("does not use console.log", () => {
      log.warn("careful");
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  // ─── error ──────────────────────────────────────────────────────────

  describe("error", () => {
    it("prints the message to console.error", () => {
      log.error("fail");
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0][1]).toBe("fail");
    });

    it("does not use console.log", () => {
      log.error("fail");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("prefixes with the error icon", () => {
      log.error("test");
      const prefix = errorSpy.mock.calls[0][0] as string;
      expect(prefix).toContain("✖");
    });
  });

  // ─── task ───────────────────────────────────────────────────────────

  describe("task", () => {
    it("prints 1-based index out of total", () => {
      log.task(0, 5, "doing stuff");
      expect(logSpy).toHaveBeenCalledOnce();
      const prefix = logSpy.mock.calls[0][0] as string;
      expect(prefix).toContain("[1/5]");
    });

    it("passes the message as the second argument", () => {
      log.task(2, 10, "my task");
      expect(logSpy.mock.calls[0][1]).toBe("my task");
    });

    it("correctly increments index for last task", () => {
      log.task(4, 5, "last");
      const prefix = logSpy.mock.calls[0][0] as string;
      expect(prefix).toContain("[5/5]");
    });
  });

  // ─── dim ────────────────────────────────────────────────────────────

  describe("dim", () => {
    it("prints the message to console.log", () => {
      log.dim("subtle");
      expect(logSpy).toHaveBeenCalledOnce();
    });

    it("passes the message through chalk.dim", () => {
      log.dim("subtle text");
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("subtle text");
    });
  });

  // ─── debug ──────────────────────────────────────────────────────────

  describe("debug", () => {
    it("does not print when verbose is false", () => {
      log.verbose = false;
      log.debug("hidden");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("prints when verbose is true", () => {
      log.verbose = true;
      log.debug("visible");
      expect(logSpy).toHaveBeenCalledOnce();
    });

    it("includes the message text in the output", () => {
      log.verbose = true;
      log.debug("detail");
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("detail");
    });

    it("includes the arrow prefix", () => {
      log.verbose = true;
      log.debug("test");
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("⤷");
    });

    it("respects toggling verbose on and off", () => {
      log.verbose = true;
      log.debug("first");
      expect(logSpy).toHaveBeenCalledOnce();

      log.verbose = false;
      log.debug("second");
      expect(logSpy).toHaveBeenCalledOnce(); // still 1 call

      log.verbose = true;
      log.debug("third");
      expect(logSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ─── formatErrorChain ──────────────────────────────────────────────

  describe("formatErrorChain", () => {
    it("formats a single Error", () => {
      const result = log.formatErrorChain(new Error("boom"));
      expect(result).toBe("Error: boom");
    });

    it("formats an error with one level of cause", () => {
      const inner = new Error("root cause");
      const outer = new Error("wrapper", { cause: inner });
      const result = log.formatErrorChain(outer);
      expect(result).toBe("Error: wrapper\n  ⤷ Cause: root cause");
    });

    it("formats a deeply nested cause chain", () => {
      const e1 = new Error("level 0");
      const e2 = new Error("level 1", { cause: e1 });
      const e3 = new Error("level 2", { cause: e2 });
      const result = log.formatErrorChain(e3);
      expect(result).toBe(
        "Error: level 2\n  ⤷ Cause: level 1\n  ⤷ Cause: level 0",
      );
    });

    it("stops at depth 5 to prevent infinite loops", () => {
      let current: Error = new Error("base");
      for (let i = 0; i < 5; i++) {
        current = new Error(`level ${i + 1}`, { cause: current });
      }
      const result = log.formatErrorChain(current);
      const parts = result.split("\n  ⤷ ");
      expect(parts.length).toBeLessThanOrEqual(5);
    });

    it("formats a non-Error value", () => {
      const result = log.formatErrorChain("string error");
      expect(result).toBe("Error: string error");
    });

    it("formats a number value", () => {
      const result = log.formatErrorChain(404);
      expect(result).toBe("Error: 404");
    });

    it("formats null", () => {
      const result = log.formatErrorChain(null);
      expect(result).toBe("");
    });

    it("formats an error whose cause is a non-Error value", () => {
      const err = new Error("outer", { cause: "inner string" });
      const result = log.formatErrorChain(err);
      expect(result).toBe("Error: outer\n  ⤷ Cause: inner string");
    });
  });

  // ─── extractMessage ─────────────────────────────────────────────────

  describe("extractMessage", () => {
    it("returns the message of an Error", () => {
      const result = log.extractMessage(new Error("boom"));
      expect(result).toBe("boom");
    });

    it("returns the string representation of a non-Error string", () => {
      const result = log.extractMessage("string error");
      expect(result).toBe("string error");
    });

    it("returns the string representation of a non-Error number", () => {
      const result = log.extractMessage(404);
      expect(result).toBe("404");
    });

    it('returns "" for null', () => {
      const result = log.extractMessage(null);
      expect(result).toBe("");
    });

    it('returns "" for undefined', () => {
      const result = log.extractMessage(undefined);
      expect(result).toBe("");
    });
  });

  // ─── verbose getter/setter ─────────────────────────────────────────

  describe("verbose getter/setter", () => {
    it("returns false by default", () => {
      log.verbose = false;
      expect(log.verbose).toBe(false);
    });

    it("returns true after setting to true", () => {
      log.verbose = true;
      expect(log.verbose).toBe(true);
    });

    it("setting verbose true sets level to debug", () => {
      log.verbose = true;
      expect(getLogLevel()).toBe("debug");
    });

    it("setting verbose false sets level to info", () => {
      log.verbose = true;
      log.verbose = false;
      expect(getLogLevel()).toBe("info");
    });
  });

  // ─── getLogLevel ──────────────────────────────────────────────────

  describe("getLogLevel", () => {
    it("returns info by default", () => {
      log.verbose = false;
      expect(getLogLevel()).toBe("info");
    });

    it("returns debug when verbose is true", () => {
      log.verbose = true;
      expect(getLogLevel()).toBe("debug");
    });
  });

  // ─── level resolution from environment ────────────────────────────

  describe("level resolution from environment", () => {
    beforeEach(() => {
      vi.resetModules();
      delete process.env.LOG_LEVEL;
      delete process.env.DEBUG;
    });

    it("defaults to info level", async () => {
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("info");
    });

    it("respects LOG_LEVEL=debug", async () => {
      process.env.LOG_LEVEL = "debug";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("debug");
    });

    it("respects LOG_LEVEL=warn", async () => {
      process.env.LOG_LEVEL = "warn";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("warn");
    });

    it("respects LOG_LEVEL=error", async () => {
      process.env.LOG_LEVEL = "error";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("error");
    });

    it("LOG_LEVEL is case-insensitive", async () => {
      process.env.LOG_LEVEL = "DEBUG";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("debug");
    });

    it("falls back to debug when DEBUG is set", async () => {
      process.env.DEBUG = "1";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("debug");
    });

    it("LOG_LEVEL takes priority over DEBUG", async () => {
      process.env.LOG_LEVEL = "warn";
      process.env.DEBUG = "1";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("warn");
    });

    it("ignores invalid LOG_LEVEL values", async () => {
      process.env.LOG_LEVEL = "verbose";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("info");
    });

    it("ignores prototype LOG_LEVEL keys like toString", async () => {
      process.env.LOG_LEVEL = "toString";
      const { getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("info");
    });

    it("verbose setter overrides env-var-resolved level", async () => {
      process.env.LOG_LEVEL = "warn";
      const { log, getLogLevel } = await import("../helpers/logger.js");
      expect(getLogLevel()).toBe("warn");
      log.verbose = true;
      expect(getLogLevel()).toBe("debug");
    });
  });
});
