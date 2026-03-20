import { describe, it, expect, vi } from "vitest";
import { sanitizeProgressText, createProgressReporter } from "../providers/progress.js";

// ─── sanitizeProgressText ─────────────────────────────────────────

describe("sanitizeProgressText", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeProgressText("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeProgressText("   \t\n  ")).toBe("");
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeProgressText("  hello   world  ")).toBe("hello world");
  });

  it("strips ANSI color codes", () => {
    expect(sanitizeProgressText("\u001B[31mred text\u001B[0m")).toBe("red text");
  });

  it("strips ANSI escape sequences (cursor movement, erase)", () => {
    expect(sanitizeProgressText("\u001B[2Jhello\u001B[H")).toBe("hello");
  });

  it("strips OSC sequences (e.g. title setting)", () => {
    expect(sanitizeProgressText("\u001B]0;title\u0007actual text")).toBe("actual text");
  });

  it("strips control characters", () => {
    expect(sanitizeProgressText("hello\x00\x01\x02world")).toBe("helloworld");
  });

  it("handles input that is only ANSI codes", () => {
    expect(sanitizeProgressText("\u001B[31m\u001B[0m")).toBe("");
  });

  it("handles mixed ANSI codes and control characters", () => {
    expect(sanitizeProgressText("\u001B[1m\x07bold\u001B[0m\x00")).toBe("bold");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(200);
    const result = sanitizeProgressText(long, 120);
    expect(result.length).toBe(120);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate text at exactly maxLength", () => {
    const exact = "a".repeat(120);
    expect(sanitizeProgressText(exact, 120)).toBe(exact);
  });

  it("does not truncate text shorter than maxLength", () => {
    expect(sanitizeProgressText("short", 120)).toBe("short");
  });

  it("returns ellipsis for maxLength=1 with non-empty input", () => {
    expect(sanitizeProgressText("hello", 1)).toBe("…");
  });

  it("returns empty string for maxLength=0 with non-empty input", () => {
    expect(sanitizeProgressText("hello", 0)).toBe("");
  });

  it("trims trailing whitespace before appending ellipsis", () => {
    // Input where the truncation point lands after a space
    const input = "hello world this is a test";
    const result = sanitizeProgressText(input, 7);
    // "hello " (6 chars) + "…" but trimEnd removes trailing space
    expect(result).toBe("hello…");
    expect(result.endsWith("…")).toBe(true);
  });

  it("uses default maxLength of 120", () => {
    const long = "b".repeat(200);
    const result = sanitizeProgressText(long);
    expect(result.length).toBe(120);
  });
});

// ─── createProgressReporter ───────────────────────────────────────

describe("createProgressReporter", () => {
  it("calls onProgress with sanitized text", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("hello world");
    expect(cb).toHaveBeenCalledWith({ text: "hello world" });
  });

  it("does not call onProgress for empty text", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("");
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call onProgress for null/undefined input", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit(null);
    reporter.emit(undefined);
    expect(cb).not.toHaveBeenCalled();
  });

  it("deduplicates consecutive identical values", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("same");
    reporter.emit("same");
    reporter.emit("same");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("emits again after value changes", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("first");
    reporter.emit("second");
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith({ text: "first" });
    expect(cb).toHaveBeenCalledWith({ text: "second" });
  });

  it("reset allows re-emission of same value", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("value");
    reporter.reset();
    reporter.emit("value");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when onProgress is undefined", () => {
    const reporter = createProgressReporter(undefined);
    // Should not throw
    reporter.emit("hello");
    reporter.reset();
  });

  it("catches and swallows callback errors", () => {
    const cb = vi.fn().mockImplementation(() => {
      throw new Error("callback error");
    });
    const reporter = createProgressReporter(cb);
    // Should not throw
    expect(() => reporter.emit("hello")).not.toThrow();
  });

  it("continues to work after a callback error", () => {
    const cb = vi.fn()
      .mockImplementationOnce(() => { throw new Error("fail"); })
      .mockImplementation(() => {});
    const reporter = createProgressReporter(cb);
    reporter.emit("first");
    reporter.emit("second");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("sanitizes ANSI codes before emitting", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("\u001B[32mgreen text\u001B[0m");
    expect(cb).toHaveBeenCalledWith({ text: "green text" });
  });

  it("deduplicates based on sanitized value not raw input", () => {
    const cb = vi.fn();
    const reporter = createProgressReporter(cb);
    reporter.emit("hello");
    reporter.emit("\u001B[31mhello\u001B[0m");
    // Both sanitize to "hello", so second should be deduplicated
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
