/**
 * Tests for the RunQueue — SQLite-backed concurrency gate for MCP runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockCountActiveRuns,
  mockGetNextQueued,
  mockMarkRunStarted,
  mockMarkSpecRunStarted,
  mockFailAllQueuedRuns,
  mockEmitLog,
} = vi.hoisted(() => ({
  mockCountActiveRuns: vi.fn().mockReturnValue(0),
  mockGetNextQueued: vi.fn().mockReturnValue(null),
  mockMarkRunStarted: vi.fn(),
  mockMarkSpecRunStarted: vi.fn(),
  mockFailAllQueuedRuns: vi.fn(),
  mockEmitLog: vi.fn(),
}));

const { mockForkDispatchRun, capturedOnExit } = vi.hoisted(() => {
  const capturedOnExit: Array<((code: number | null) => void)> = [];
  const mockForkDispatchRun = vi.fn().mockImplementation(
    (_runId: string, _msg: unknown, opts?: { onExit?: (code: number | null) => void }) => {
      if (opts?.onExit) capturedOnExit.push(opts.onExit);
      return { on: vi.fn(), send: vi.fn(), kill: vi.fn() };
    },
  );
  return { mockForkDispatchRun, capturedOnExit };
});

// ─── Module mocks ────────────────────────────────────────────

vi.mock("../mcp/state/manager.js", () => ({
  countActiveRuns: mockCountActiveRuns,
  getNextQueued: mockGetNextQueued,
  markRunStarted: mockMarkRunStarted,
  markSpecRunStarted: mockMarkSpecRunStarted,
  failAllQueuedRuns: mockFailAllQueuedRuns,
  emitLog: mockEmitLog,
  addLogCallback: vi.fn(),
}));

vi.mock("../queue/fork-run.js", () => ({
  forkDispatchRun: mockForkDispatchRun,
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { RunQueue, initRunQueue, getRunQueue, resetRunQueue } from "../queue/run-queue.js";

// ─── Helpers ────────────────────────────────────────────────

const mockLogCallback = vi.fn();

function makeQueuedEntry(runId: string, table: "runs" | "spec_runs" = "runs") {
  return {
    runId,
    workerMessage: JSON.stringify({ type: "dispatch", cwd: "/cwd", opts: { issueIds: [runId] } }),
    table,
  };
}

// ─── Tests ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnExit.length = 0;
  mockCountActiveRuns.mockReturnValue(0);
  mockGetNextQueued.mockReturnValue(null);
  resetRunQueue();
});

describe("RunQueue", () => {
  it("forks immediately when slots are available", () => {
    const queue = new RunQueue(2);
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued.mockReturnValueOnce(makeQueuedEntry("run-1"));

    queue.enqueue("run-1", mockLogCallback);

    expect(mockMarkRunStarted).toHaveBeenCalledWith("run-1");
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(1);
  });

  it("does not fork when all slots are occupied", () => {
    const queue = new RunQueue(1);
    mockCountActiveRuns.mockReturnValue(1);

    queue.enqueue("run-2", mockLogCallback);

    expect(mockForkDispatchRun).not.toHaveBeenCalled();
    expect(mockMarkRunStarted).not.toHaveBeenCalled();
  });

  it("drains next queued run when a child exits", () => {
    const queue = new RunQueue(1);

    // First enqueue: slot available, forks immediately
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued.mockReturnValueOnce(makeQueuedEntry("run-1"));
    queue.enqueue("run-1", mockLogCallback);
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(1);

    // Second enqueue: no slot
    mockCountActiveRuns.mockReturnValue(1);
    queue.enqueue("run-2", mockLogCallback);
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(1); // still 1

    // Simulate first child exiting → should drain run-2
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued.mockReturnValueOnce(makeQueuedEntry("run-2"));
    capturedOnExit[0]!(0);

    expect(mockMarkRunStarted).toHaveBeenCalledWith("run-2");
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(2);
  });

  it("uses markSpecRunStarted for spec runs", () => {
    const queue = new RunQueue(2);
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued.mockReturnValueOnce(makeQueuedEntry("spec-1", "spec_runs"));

    queue.enqueue("spec-1", mockLogCallback);

    expect(mockMarkSpecRunStarted).toHaveBeenCalledWith("spec-1");
    expect(mockMarkRunStarted).not.toHaveBeenCalled();
  });

  it("respects concurrency limit across multiple enqueues", () => {
    const queue = new RunQueue(2);

    // First enqueue: slot available, forks run-1
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued
      .mockReturnValueOnce(makeQueuedEntry("run-1"))
      .mockReturnValueOnce(null); // no more queued after run-1
    queue.enqueue("run-1", mockLogCallback);
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(1);

    // Second enqueue: 1 slot used, 1 free — forks run-2
    mockCountActiveRuns.mockReturnValue(1);
    mockGetNextQueued
      .mockReturnValueOnce(makeQueuedEntry("run-2"))
      .mockReturnValueOnce(null);
    queue.enqueue("run-2", mockLogCallback);
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(2);

    // Third enqueue: both slots full — does NOT fork
    mockCountActiveRuns.mockReturnValue(2);
    queue.enqueue("run-3", mockLogCallback);
    expect(mockForkDispatchRun).toHaveBeenCalledTimes(2); // still 2
  });

  it("skips entries with missing context gracefully", () => {
    const queue = new RunQueue(2);
    mockCountActiveRuns.mockReturnValue(0);

    // Return a queued entry for a run that was never enqueued (no in-memory context)
    mockGetNextQueued.mockReturnValueOnce(makeQueuedEntry("orphan-run"));

    // Call drain directly (this would happen on startup)
    queue.drain();

    // Should not fork because there's no server context for the orphaned run
    expect(mockForkDispatchRun).not.toHaveBeenCalled();
  });

  it("skips entries with invalid worker message JSON", () => {
    const queue = new RunQueue(2);
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued.mockReturnValueOnce({
      runId: "bad-json",
      workerMessage: "not valid json{{{",
      table: "runs" as const,
    });

    // Register the context so it's not skipped for that reason
    queue.enqueue("bad-json", mockLogCallback);

    expect(mockForkDispatchRun).not.toHaveBeenCalled();
    expect(mockEmitLog).toHaveBeenCalledWith("bad-json", expect.stringContaining("Failed to parse"), "error");
  });

  it("calls user onExit callback when child exits", () => {
    const queue = new RunQueue(1);
    const userOnExit = vi.fn();
    mockCountActiveRuns.mockReturnValue(0);
    mockGetNextQueued.mockReturnValueOnce(makeQueuedEntry("run-1"));

    queue.enqueue("run-1", mockLogCallback, { onExit: userOnExit });

    // Simulate child exit
    mockCountActiveRuns.mockReturnValue(0);
    capturedOnExit[0]!(0);

    expect(userOnExit).toHaveBeenCalledWith(0);
  });

  it("abort marks all queued runs as failed", () => {
    const queue = new RunQueue(2);
    queue.abort();
    expect(mockFailAllQueuedRuns).toHaveBeenCalledTimes(1);
  });

  it("exposes maxRuns", () => {
    const queue = new RunQueue(5);
    expect(queue.maxRuns).toBe(5);
  });

  it("clamps limit to minimum of 1", () => {
    const queue = new RunQueue(0);
    expect(queue.maxRuns).toBe(1);
  });
});

describe("RunQueue singleton", () => {
  it("throws when getRunQueue called before init", () => {
    expect(() => getRunQueue()).toThrow("RunQueue not initialized");
  });

  it("initRunQueue + getRunQueue returns the same instance", () => {
    initRunQueue(3);
    const q1 = getRunQueue();
    const q2 = getRunQueue();
    expect(q1).toBe(q2);
    expect(q1.maxRuns).toBe(3);
  });

  it("resetRunQueue clears the singleton", () => {
    initRunQueue(2);
    expect(getRunQueue().maxRuns).toBe(2);
    resetRunQueue();
    expect(() => getRunQueue()).toThrow("RunQueue not initialized");
  });
});
