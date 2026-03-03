import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../helpers/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    task: vi.fn(),
    verbose: false,
    formatErrorChain: vi.fn().mockReturnValue(""),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

import { registerCleanup, runCleanup } from "../helpers/cleanup.js";
import { log } from "../helpers/logger.js";

// ─── cleanup registry ─────────────────────────────────────────────────

describe("registerCleanup / runCleanup", () => {
  afterEach(async () => {
    // Drain any leftover registered functions to avoid cross-test pollution
    await runCleanup();
    vi.restoreAllMocks();
  });

  // ─── registerCleanup ───────────────────────────────────────────────

  it("registers a cleanup function that is called by runCleanup", async () => {
    const fn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    registerCleanup(fn);
    await runCleanup();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("registers multiple cleanup functions", async () => {
    const fn1 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fn2 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    registerCleanup(fn1);
    registerCleanup(fn2);
    await runCleanup();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  // ─── runCleanup execution order ───────────────────────────────────

  it("executes cleanup functions in registration order", async () => {
    const order: number[] = [];
    registerCleanup(async () => { order.push(1); });
    registerCleanup(async () => { order.push(2); });
    registerCleanup(async () => { order.push(3); });
    await runCleanup();
    expect(order).toEqual([1, 2, 3]);
  });

  // ─── Registry clearing ────────────────────────────────────────────

  it("clears the registry after runCleanup so subsequent calls are no-ops", async () => {
    const fn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    registerCleanup(fn);
    await runCleanup();
    expect(fn).toHaveBeenCalledOnce();

    // Second call should not invoke fn again
    await runCleanup();
    expect(fn).toHaveBeenCalledOnce();
  });

  // ─── Error handling ───────────────────────────────────────────────

  it("swallows errors thrown by a cleanup function", async () => {
    registerCleanup(async () => { throw new Error("boom"); });
    // Should not throw
    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it("continues executing remaining functions after one throws", async () => {
    const fn1 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fn2 = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("fail"));
    const fn3 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    registerCleanup(fn1);
    registerCleanup(fn2);
    registerCleanup(fn3);
    await runCleanup();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
    expect(fn3).toHaveBeenCalledOnce();
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  it("resolves cleanly when no functions are registered", async () => {
    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it("allows re-registration after a drain", async () => {
    const fn1 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fn2 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    registerCleanup(fn1);
    await runCleanup();
    expect(fn1).toHaveBeenCalledOnce();

    registerCleanup(fn2);
    await runCleanup();
    expect(fn2).toHaveBeenCalledOnce();
    expect(fn1).toHaveBeenCalledOnce(); // fn1 not called again
  });

  // ─── Signal handler integration ───────────────────────────────────

  it("can be wired to process signal handlers via process.on", async () => {
    const processOnSpy = vi.spyOn(process, "on");

    const handler = async () => {
      await runCleanup();
    };
    process.on("SIGINT", handler);

    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", handler);
    processOnSpy.mockRestore();
  });

  it("runs registered cleanups when invoked from a signal handler callback", async () => {
    const fn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    registerCleanup(fn);

    // Simulate what cli.ts does: wire runCleanup to a signal
    const processOnSpy = vi.spyOn(process, "on");
    const signalHandler = async () => { await runCleanup(); };
    process.on("SIGTERM", signalHandler);

    expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", signalHandler);

    // Invoke the handler directly (don't actually send a signal)
    await signalHandler();
    expect(fn).toHaveBeenCalledOnce();

    processOnSpy.mockRestore();
  });

  // ─── Cleanup failure logging (depends on error-handling-improvements) ─

  // TODO: Currently cleanup.ts has a bare `catch {}` that swallows errors
  // silently. Once the error-handling-improvements spec adds `log.warn()`
  // to the catch block, remove the `.skip` and this test will verify the
  // warn log is emitted for cleanup failures.
  it.skip("logs a warning when a cleanup function rejects", async () => {
    const succeed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fail = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("cleanup boom"));

    registerCleanup(succeed);
    registerCleanup(fail);

    await runCleanup();

    // Both functions must have been called
    expect(succeed).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();

    // The rejection should be swallowed (runCleanup must not throw)
    // — already covered by existing tests, but confirmed here too.

    // Once error-handling-improvements lands, a warn log should be emitted
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
