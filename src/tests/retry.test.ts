import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../helpers/retry.js";
import { log } from "../helpers/logger.js";

// ─── withRetry ──────────────────────────────────────────────────────

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

    const result = await withRetry(fn, 3);

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries up to maxAttempts and returns on the last successful attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("third-time");

    const result = await withRetry(fn, 3);

    expect(result).toBe("third-time");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ─── All attempts exhausted ──────────────────────────────────────

  it("throws the last error when all attempts fail", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockRejectedValueOnce(new Error("fail-3"));

    await expect(withRetry(fn, 3)).rejects.toThrow("fail-3");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when maxAttempts is 1 and fn fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("only-try"));

    await expect(withRetry(fn, 1)).rejects.toThrow("only-try");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ─── Logging behaviour ───────────────────────────────────────────

  it("logs a warning and debug message for each failed non-final attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("err-1"))
      .mockRejectedValueOnce(new Error("err-2"))
      .mockResolvedValue("ok");

    await withRetry(fn, 3);

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalledTimes(2);
  });

  it("does not log on the final failed attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("err-1"))
      .mockRejectedValueOnce(new Error("err-2"));

    await expect(withRetry(fn, 2)).rejects.toThrow("err-2");

    // Only the first failure should be logged (attempt 1 of 2)
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  it("includes the label in log messages when provided", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");

    await withRetry(fn, 2, { label: "planner.plan()" });

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

    await withRetry(fn, 3);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("1/3"),
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("2/3"),
    );
  });

  // ─── Edge cases ──────────────────────────────────────────────────

  it("preserves the error type when re-throwing", async () => {
    class CustomError extends Error {
      code = "CUSTOM";
    }
    const fn = vi.fn().mockRejectedValue(new CustomError("custom"));

    await expect(withRetry(fn, 1)).rejects.toBeInstanceOf(CustomError);
  });

  it("handles non-Error thrown values", async () => {
    const fn = vi.fn().mockRejectedValue("string-error");

    await expect(withRetry(fn, 1)).rejects.toBe("string-error");
  });

  it("works with maxAttempts of 1 and successful fn", async () => {
    const fn = vi.fn().mockResolvedValue(42);

    const result = await withRetry(fn, 1);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
