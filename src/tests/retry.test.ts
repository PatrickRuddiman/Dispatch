import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../helpers/retry.js";
import { log } from "../helpers/logger.js";

// ─── withRetry ──────────────────────────────────────────────────────

/** Shorthand to skip backoff delays in most tests. */
const NO_DELAY = { baseDelayMs: 0 };

describe("withRetry", () => {
  beforeEach(() => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(log, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Successful on first attempt ─────────────────────────────────

  it("returns the value when fn succeeds on the first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, 3);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not log when fn succeeds on the first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await withRetry(fn, 3);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  // ─── Successful after retries ────────────────────────────────────

  it("returns the value when fn succeeds on a subsequent attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, 3, NO_DELAY);

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries up to maxAttempts and returns on the last successful attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("third-time");

    const result = await withRetry(fn, 3, NO_DELAY);

    expect(result).toBe("third-time");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ─── All attempts exhausted ──────────────────────────────────────

  it("throws the last error when all attempts fail", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockRejectedValueOnce(new Error("fail-3"))
      .mockRejectedValueOnce(new Error("fail-4"));

    await expect(withRetry(fn, 3, NO_DELAY)).rejects.toThrow("fail-4");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("throws immediately when maxRetries is 0 and fn fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("only-try"));

    await expect(withRetry(fn, 0)).rejects.toThrow("only-try");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ─── Logging behaviour ───────────────────────────────────────────

  it("logs a warning and debug message for each failed non-final attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("err-1"))
      .mockRejectedValueOnce(new Error("err-2"))
      .mockResolvedValue("ok");

    await withRetry(fn, 3, NO_DELAY);

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalledTimes(2);
  });

  it("does not log on the final failed attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("err-1"))
      .mockRejectedValueOnce(new Error("err-2"))
      .mockRejectedValueOnce(new Error("err-3"));

    await expect(withRetry(fn, 2, NO_DELAY)).rejects.toThrow("err-3");

    // Only the first two failures should be logged (attempts 1 and 2 of 3)
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalledTimes(2);
  });

  it("includes the label in log messages when provided", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");

    await withRetry(fn, 2, { label: "planner.plan()", baseDelayMs: 0 });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[planner.plan()]"),
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("[planner.plan()]"),
    );
  });

  it("includes attempt counts in log messages", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("oops"))
      .mockResolvedValue("ok");

    await withRetry(fn, 3, NO_DELAY);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("1/4"),
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("2/4"),
    );
  });

  // ─── Backoff behaviour ──────────────────────────────────────────

  it("applies exponential backoff between retry attempts", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return origSetTimeout(fn, 0);
    }) as typeof setTimeout);

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("ok");

    await withRetry(fn, 3, { baseDelayMs: 100 });

    // Delays should increase exponentially: ~100 (100*2^0 + jitter), ~200 (100*2^1 + jitter)
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(300);
  });

  // ─── Edge cases ──────────────────────────────────────────────────

  it("preserves the error type when re-throwing", async () => {
    class CustomError extends Error {
      code = "CUSTOM";
    }
    const fn = vi.fn().mockRejectedValue(new CustomError("custom"));

    await expect(withRetry(fn, 0)).rejects.toBeInstanceOf(CustomError);
  });

  it("handles non-Error thrown values", async () => {
    const fn = vi.fn().mockRejectedValue("string-error");

    await expect(withRetry(fn, 0)).rejects.toBe("string-error");
  });

  it("works with maxRetries of 0 and successful fn", async () => {
    const fn = vi.fn().mockResolvedValue(42);

    const result = await withRetry(fn, 0);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
