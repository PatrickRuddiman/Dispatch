import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { withTimeout, TimeoutError } from "../timeout.js";

// ─── TimeoutError ────────────────────────────────────────────────────

describe("TimeoutError", () => {
  it("is an instance of Error", () => {
    const err = new TimeoutError(1000);
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of TimeoutError", () => {
    const err = new TimeoutError(1000);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("has name set to 'TimeoutError'", () => {
    const err = new TimeoutError(1000);
    expect(err.name).toBe("TimeoutError");
  });

  it("stores the provided message without label", () => {
    const err = new TimeoutError(5000);
    expect(err.message).toBe("Timed out after 5000ms");
  });

  it("includes the label in the message when provided", () => {
    const err = new TimeoutError(3000, "planning phase");
    expect(err.message).toBe("Timed out after 3000ms [planning phase]");
  });

  it("exposes the label property", () => {
    const err = new TimeoutError(1000, "my-op");
    expect(err.label).toBe("my-op");
  });

  it("has undefined label when none is provided", () => {
    const err = new TimeoutError(1000);
    expect(err.label).toBeUndefined();
  });
});

// ─── withTimeout ─────────────────────────────────────────────────────

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Successful resolution before timeout ────────────────────────

  it("resolves with the promise value when it settles before the timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("hello"), 100);
    });

    const resultPromise = withTimeout(promise, 5000);
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toBe("hello");
  });

  it("resolves with a numeric value", async () => {
    const promise = new Promise<number>((resolve) => {
      setTimeout(() => resolve(42), 50);
    });

    const resultPromise = withTimeout(promise, 1000);
    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toBe(42);
  });

  it("propagates the original rejection when the promise rejects before the timeout", async () => {
    const promise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("original error")), 100);
    });

    const resultPromise = withTimeout(promise, 5000);
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).rejects.toThrow("original error");
  });

  // ─── Timeout rejection with TimeoutError ─────────────────────────

  it("rejects with a TimeoutError when the promise does not settle in time", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withTimeout(promise, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).rejects.toBeInstanceOf(TimeoutError);
  });

  it("includes the timeout duration in the error message", async () => {
    const promise = new Promise<string>(() => {}); // never resolves

    const resultPromise = withTimeout(promise, 5000);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).rejects.toThrow("5000ms");
  });

  // ─── Custom error label ──────────────────────────────────────────

  it("includes the custom label in the timeout error message", async () => {
    const promise = new Promise<string>(() => {}); // never resolves

    const resultPromise = withTimeout(promise, 3000, "planning phase");
    await vi.advanceTimersByTimeAsync(3000);

    await expect(resultPromise).rejects.toThrow("planning phase");
  });

  it("uses a default message when no label is provided", async () => {
    const promise = new Promise<string>(() => {}); // never resolves

    const resultPromise = withTimeout(promise, 2000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(resultPromise).rejects.toThrow("Timed out after 2000ms");
  });

  it("formats the message with label correctly", async () => {
    const promise = new Promise<string>(() => {}); // never resolves

    const resultPromise = withTimeout(promise, 7000, "planner.plan()");
    await vi.advanceTimersByTimeAsync(7000);

    await expect(resultPromise).rejects.toThrow(
      "Timed out after 7000ms [planner.plan()]",
    );
  });

  // ─── Edge cases ──────────────────────────────────────────────────

  it("resolves immediately for an already-resolved promise", async () => {
    const promise = Promise.resolve("instant");

    const resultPromise = withTimeout(promise, 5000);
    // Flush microtasks — no timer advance needed for an already-resolved promise
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toBe("instant");
  });

  it("rejects immediately for an already-rejected promise", async () => {
    const promise = Promise.reject(new Error("already failed"));
    // Attach a no-op handler to prevent unhandled rejection warning
    promise.catch(() => {});

    const resultPromise = withTimeout(promise, 5000);
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).rejects.toThrow("already failed");
  });

  it("rejects with TimeoutError for zero timeout when promise is pending", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("delayed"), 1);
    });

    const resultPromise = withTimeout(promise, 0);
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).rejects.toBeInstanceOf(TimeoutError);
  });

  it("clears the internal timer after the promise resolves (no leaked timers)", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("done"), 50);
    });

    const resultPromise = withTimeout(promise, 5000);
    await vi.advanceTimersByTimeAsync(50);
    await resultPromise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
