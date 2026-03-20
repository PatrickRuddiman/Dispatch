import { describe, it, expect, vi } from "vitest";
import { runWithConcurrency } from "../helpers/concurrency.js";
import type { ConcurrencyResult } from "../helpers/concurrency.js";

// ─── runWithConcurrency ──────────────────────────────────────────────

describe("runWithConcurrency", () => {
  // ─── Basic behaviour ──────────────────────────────────────────────

  it("returns an empty array when given no items", async () => {
    const results = await runWithConcurrency({
      items: [],
      concurrency: 3,
      worker: async () => "nope",
    });

    expect(results).toEqual([]);
  });

  it("processes all items and returns results in input order", async () => {
    const items = [1, 2, 3, 4, 5];

    const results = await runWithConcurrency({
      items,
      concurrency: 2,
      worker: async (n) => n * 10,
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
      { status: "fulfilled", value: 50 },
    ]);
  });

  it("processes all items with concurrency of 1 (sequential)", async () => {
    const order: number[] = [];

    await runWithConcurrency({
      items: [1, 2, 3],
      concurrency: 1,
      worker: async (n) => {
        order.push(n);
        return n;
      },
    });

    expect(order).toEqual([1, 2, 3]);
  });

  // ─── Concurrency limit ────────────────────────────────────────────

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const limit = 3;

    await runWithConcurrency({
      items: Array.from({ length: 10 }, (_, i) => i),
      concurrency: limit,
      worker: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
    });

    expect(maxActive).toBe(limit);
  });

  it("handles concurrency greater than the number of items", async () => {
    let maxActive = 0;
    let active = 0;

    const results = await runWithConcurrency({
      items: [1, 2],
      concurrency: 10,
      worker: async (n) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return n;
      },
    });

    expect(maxActive).toBe(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toEqual({ status: "fulfilled", value: 2 });
  });

  // ─── Sliding window behaviour ─────────────────────────────────────

  it("starts a new task as soon as one completes (sliding window)", async () => {
    const events: string[] = [];

    await runWithConcurrency({
      items: [1, 2, 3],
      concurrency: 2,
      worker: async (n) => {
        events.push(`start-${n}`);
        // Item 1 completes quickly, item 2 takes longer
        await new Promise((r) => setTimeout(r, n === 1 ? 5 : 20));
        events.push(`end-${n}`);
      },
    });

    // Item 3 should start after item 1 ends, not after item 2 ends
    const start3Index = events.indexOf("start-3");
    const end1Index = events.indexOf("end-1");
    const end2Index = events.indexOf("end-2");
    expect(start3Index).toBeGreaterThan(end1Index);
    expect(start3Index).toBeLessThan(end2Index);
  });

  // ─── Error handling ───────────────────────────────────────────────

  it("captures worker errors as rejected results without stopping other items", async () => {
    const results = await runWithConcurrency({
      items: [1, 2, 3],
      concurrency: 3,
      worker: async (n) => {
        if (n === 2) throw new Error("item-2-failed");
        return n * 10;
      },
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]).toEqual({ status: "rejected", reason: expect.any(Error) });
    expect((results[1] as { status: "rejected"; reason: Error }).reason.message).toBe("item-2-failed");
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
  });

  it("handles all items failing", async () => {
    const results = await runWithConcurrency({
      items: [1, 2, 3],
      concurrency: 2,
      worker: async (n) => {
        throw new Error(`fail-${n}`);
      },
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  });

  // ─── Early termination (shouldStop) ───────────────────────────────

  it("stops launching new items when shouldStop returns true", async () => {
    let launched = 0;
    let stopSignal = false;

    const results = await runWithConcurrency({
      items: [1, 2, 3, 4, 5],
      concurrency: 1,
      worker: async (n) => {
        launched++;
        if (n === 2) stopSignal = true;
        return n;
      },
      shouldStop: () => stopSignal,
    });

    // Items 1 and 2 run. After 2 completes and sets the flag, 3/4/5 are not launched.
    expect(launched).toBe(2);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toEqual({ status: "fulfilled", value: 2 });
    // Remaining items are marked as skipped
    expect(results[2]).toEqual({ status: "skipped" });
    expect(results[3]).toEqual({ status: "skipped" });
    expect(results[4]).toEqual({ status: "skipped" });
  });

  it("allows already-running workers to finish when shouldStop fires", async () => {
    let stopSignal = false;
    const completed: number[] = [];

    await runWithConcurrency({
      items: [1, 2, 3, 4],
      concurrency: 2,
      worker: async (n) => {
        if (n === 1) {
          // Yield so both items 1 and 2 are launched before stop fires.
          // Without this, the synchronous body would set stopSignal
          // before the launch() loop starts item 2.
          await Promise.resolve();
          stopSignal = true;
          completed.push(n);
          return n;
        }
        // Item 2 is already running when stop fires
        await new Promise((r) => setTimeout(r, 20));
        completed.push(n);
        return n;
      },
      shouldStop: () => stopSignal,
    });

    // Both 1 and 2 should complete (2 was already running)
    expect(completed).toContain(1);
    expect(completed).toContain(2);
    // Items 3 and 4 should NOT have been launched
    expect(completed).not.toContain(3);
    expect(completed).not.toContain(4);
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  it("clamps concurrency to at least 1 when given 0", async () => {
    const results = await runWithConcurrency({
      items: [1, 2],
      concurrency: 0,
      worker: async (n) => n,
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });

  it("passes the item index to the worker", async () => {
    const indices: number[] = [];

    await runWithConcurrency({
      items: ["a", "b", "c"],
      concurrency: 2,
      worker: async (_, idx) => {
        indices.push(idx);
      },
    });

    expect(indices.sort()).toEqual([0, 1, 2]);
  });

  it("clamps concurrency to at least 1 when given a negative value", async () => {
    const results = await runWithConcurrency({
      items: [1, 2],
      concurrency: -5,
      worker: async (n) => n * 2,
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
    ]);
  });

  it("launches no items when shouldStop is true from the start", async () => {
    const workerFn = vi.fn().mockResolvedValue("nope");

    const results = await runWithConcurrency({
      items: [1, 2, 3],
      concurrency: 2,
      worker: workerFn,
      shouldStop: () => true,
    });

    expect(workerFn).not.toHaveBeenCalled();
    expect(results).toEqual([
      { status: "skipped" },
      { status: "skipped" },
      { status: "skipped" },
    ]);
  });

  it("captures non-Error thrown values as rejection reasons", async () => {
    const results = await runWithConcurrency({
      items: ["ok", "string-throw", "number-throw"],
      concurrency: 3,
      worker: async (item) => {
        if (item === "string-throw") throw "a string reason";
        if (item === "number-throw") throw 42;
        return item;
      },
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(results[1]).toEqual({ status: "rejected", reason: "a string reason" });
    expect(results[2]).toEqual({ status: "rejected", reason: 42 });
  });

  it("marks unprocessed items as skipped when shouldStop fires mid-batch", async () => {
    let stopSignal = false;

    const results = await runWithConcurrency({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      worker: async (n) => {
        if (n === 1) stopSignal = true;
        await new Promise((r) => setTimeout(r, 10));
        return n * 10;
      },
      shouldStop: () => stopSignal,
    });

    // Item 1 launches and synchronously sets stopSignal before awaiting,
    // so shouldStop() returns true before item 2 is launched.
    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    // Remaining items are skipped because shouldStop fired before they launched
    for (let i = 1; i < 5; i++) {
      expect(results[i]).toEqual({ status: "skipped" });
    }
  });

  it("handles a single item", async () => {
    const results = await runWithConcurrency({
      items: ["only"],
      concurrency: 5,
      worker: async (item) => item.toUpperCase(),
    });

    expect(results).toEqual([{ status: "fulfilled", value: "ONLY" }]);
  });
});
