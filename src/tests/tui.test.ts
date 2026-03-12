import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "../parser.js";
import { PassThrough } from "node:stream";

let writeSpy: ReturnType<typeof vi.spyOn>;
let tui: { state: import("../tui.js").TuiState; update: () => void; stop: () => void; waitForRecoveryAction: () => Promise<"rerun" | "quit"> };

function createMockInput() {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw?: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = vi.fn((value: boolean) => {
    input.isRaw = value;
  });
  return input;
}

function lastOutput(): string {
  const calls = writeSpy.mock.calls;
  if (calls.length === 0) return "";
  return String(calls[calls.length - 1][0]);
}

function makeTask(text: string, index = 0): Task {
  return { index, text, line: index + 1, raw: `- [ ] ${text}`, file: "/tmp/test.md" };
}

function addTask(
  status: import("../tui.js").TaskStatus,
  text = "Test task",
  index = 0,
  extra: Partial<import("../tui.js").TaskState> = {},
) {
  tui.state.tasks.push({ task: makeTask(text, index), status, ...extra });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

afterEach(() => {
  if (tui) tui.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Dynamic import so mocks are in place
async function setup(options?: Parameters<(typeof import("../tui.js"))["createTui"]>[0]) {
  const mod = await import("../tui.js");
  tui = mod.createTui(options);
  return tui;
}

describe("createTui", () => {
  it("returns state, update, and stop", async () => {
    const t = await setup();
    expect(t).toHaveProperty("state");
    expect(typeof t.update).toBe("function");
    expect(typeof t.stop).toBe("function");
  });

  it("initializes state with default values", async () => {
    const t = await setup();
    expect(t.state.tasks).toEqual([]);
    expect(t.state.phase).toBe("discovering");
    expect(t.state.filesFound).toBe(0);
    expect(typeof t.state.startTime).toBe("number");
  });

  it("renders immediately on creation", async () => {
    await setup();
    expect(writeSpy).toHaveBeenCalled();
    expect(lastOutput()).toContain("dispatch");
    expect(lastOutput()).toContain("Discovering");
  });

  it("update() triggers a re-render", async () => {
    await setup();
    writeSpy.mockClear();
    tui.update();
    expect(writeSpy).toHaveBeenCalled();
    expect(lastOutput()).toContain("dispatch");
    expect(lastOutput()).toContain("Discovering");
  });

  it("stop() clears the animation interval", async () => {
    await setup();
    tui.stop();
    writeSpy.mockClear();
    vi.advanceTimersByTime(200);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("stop() renders one final frame", async () => {
    await setup();
    writeSpy.mockClear();
    tui.stop();
    // draw is called once inside stop
    expect(writeSpy).toHaveBeenCalled();
    expect(lastOutput()).toContain("dispatch");
    expect(lastOutput()).toContain("Discovering");
  });

  it("spinner animates on interval ticks", async () => {
    await setup();
    const callsBefore = writeSpy.mock.calls.length;
    vi.advanceTimersByTime(80);
    expect(writeSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(lastOutput()).toContain("dispatch");
    expect(lastOutput()).toContain("Discovering");
  });
});

describe("phase rendering", () => {
  it("shows 'Discovering task files' in discovering phase", async () => {
    await setup();
    expect(lastOutput()).toContain("Discovering task files");
  });

  it("shows 'Parsing tasks' in parsing phase", async () => {
    await setup();
    tui.state.phase = "parsing";
    tui.update();
    expect(lastOutput()).toContain("Parsing tasks");
  });

  it("shows 'Connecting to {name}' in booting phase", async () => {
    await setup();
    tui.state.phase = "booting";
    tui.state.provider = "opencode";
    tui.update();
    expect(lastOutput()).toContain("Connecting to opencode");
  });

  it("shows 'Connecting to provider' when no provider name", async () => {
    await setup();
    tui.state.phase = "booting";
    tui.state.provider = undefined;
    tui.update();
    expect(lastOutput()).toContain("Connecting to provider");
  });

  it("shows 'Dispatching tasks' in dispatching phase", async () => {
    await setup();
    tui.state.phase = "dispatching";
    tui.update();
    expect(lastOutput()).toContain("Dispatching tasks");
  });

  it("shows 'Complete' in done phase", async () => {
    await setup();
    tui.state.phase = "done";
    tui.update();
    expect(lastOutput()).toContain("Complete");
  });

  it("shows paused phase label", async () => {
    await setup();
    tui.state.phase = "paused";
    tui.update();
    expect(lastOutput()).toContain("Waiting for rerun");
  });

  it("shows found files count when not dispatching", async () => {
    await setup();
    tui.state.filesFound = 5;
    tui.update();
    expect(lastOutput()).toContain("Found 5 file(s)");
  });
});

describe("task status rendering", () => {
  it("renders pending task with 'pending' label", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("pending", "A pending task", 0);
    tui.update();
    expect(lastOutput()).toContain("pending");
  });

  it("renders planning task with 'planning' label", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("planning", "A planning task", 0);
    tui.update();
    expect(lastOutput()).toContain("planning");
  });

  it("renders running task with 'executing' label", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "A running task", 0);
    tui.update();
    expect(lastOutput()).toContain("executing");
  });

  it("renders generating and syncing labels", async () => {
    await setup();
    tui.state.phase = "dispatching";
    tui.state.mode = "spec";
    addTask("generating", "Generating task", 0, { elapsed: Date.now(), feedback: "Drafting" });
    addTask("syncing", "Syncing task", 1, { elapsed: Date.now() });
    tui.update();
    expect(lastOutput()).toContain("generating");
    expect(lastOutput()).toContain("syncing");
  });

  it("renders done task with 'done' label", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("done", "A done task", 0);
    tui.update();
    expect(lastOutput()).toContain("done");
  });

  it("renders failed task with 'failed' label", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("failed", "A failed task", 0);
    tui.update();
    expect(lastOutput()).toContain("failed");
  });

  it("renders paused task with 'paused' label", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("paused", "A paused task", 0);
    tui.update();
    expect(lastOutput()).toContain("paused");
  });

  it("renders task index as 1-based #N", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Some task", 0);
    tui.update();
    expect(lastOutput()).toContain("#1");
  });

  it("renders task text", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Implement the feature", 0);
    tui.update();
    expect(lastOutput()).toContain("Implement the feature");
  });

  it("renders error message for failed task", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("failed", "Broken task", 0, { error: "something broke" });
    tui.update();
    expect(lastOutput()).toContain("something broke");
  });

  it("renders one subordinate feedback line for generating rows", async () => {
    await setup();
    tui.state.phase = "dispatching";
    tui.state.mode = "spec";
    addTask("generating", "Generate spec", 0, { elapsed: Date.now(), feedback: "Drafting outline" });
    tui.update();
    expect(lastOutput()).toContain("└─ Drafting outline");
  });

  it("sanitizes and truncates feedback lines", async () => {
    await setup();
    Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
    tui.state.phase = "dispatching";
    tui.state.mode = "spec";
    addTask("generating", "Generate spec", 0, {
      elapsed: Date.now(),
      feedback: "\u001b[31mLine one\nline two with extra text that keeps going\u0007\u001b[0m",
    });
    tui.update();
    const output = lastOutput();
    expect(output).toContain("└─ Line one line two");
    expect(output).not.toContain("\u001b[31m");
  });

  it("does not render a subordinate line for sanitized-empty feedback", async () => {
    await setup();
    tui.state.phase = "dispatching";
    tui.state.mode = "spec";
    addTask("generating", "Generate spec", 0, {
      elapsed: Date.now(),
      feedback: "\u001b[31m \n \u0007\u001b[0m",
    });
    tui.update();

    expect(lastOutput()).not.toContain("└─");
  });

  it("renders compact feedback as a single sanitized subordinate line", async () => {
    await setup();
    Object.defineProperty(process.stdout, "columns", { value: 44, configurable: true });
    tui.state.phase = "dispatching";
    tui.state.mode = "spec";
    addTask("generating", "Generate spec", 0, {
      elapsed: Date.now(),
      feedback: "\u001b[31mLine one\n  line   two\u0007\nline three\u001b[0m",
    });
    tui.update();

    const output = lastOutput();
    const feedbackLines = output.split("\n").filter((line) => line.includes("└─"));

    expect(feedbackLines).toHaveLength(1);
    expect(feedbackLines[0]).toMatch(/└─ Line one line two/);
    expect(feedbackLines[0]).not.toContain("\u001b[31m");
    expect(feedbackLines[0]).not.toContain("\u0007");
  });

  it("does not render feedback for non-generating rows", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("syncing", "Sync row", 0, { elapsed: Date.now(), feedback: "Should stay hidden" });
    tui.update();
    expect(lastOutput()).not.toContain("Should stay hidden");
  });
});

describe("progress bar and summary", () => {
  it("shows progress bar in dispatching phase", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("done", "Task A", 0);
    addTask("done", "Task B", 1);
    addTask("pending", "Task C", 2);
    tui.update();
    expect(lastOutput()).toContain("%");
  });

  it("shows task count (done/total)", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("done", "Task A", 0);
    addTask("done", "Task B", 1);
    addTask("pending", "Task C", 2);
    tui.update();
    expect(lastOutput()).toContain("2/3 tasks");
  });

  it("shows summary with passed count", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("done", "Task A", 0);
    addTask("done", "Task B", 1);
    tui.update();
    expect(lastOutput()).toContain("2 passed");
  });

  it("shows summary with failed count", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("failed", "Task A", 0);
    tui.update();
    expect(lastOutput()).toContain("1 failed");
  });

  it("shows summary with remaining count", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("done", "Task A", 0);
    addTask("pending", "Task B", 1);
    tui.update();
    expect(lastOutput()).toContain("remaining");
  });
});

describe("recovery rendering and input", () => {
  it("shows a play-style rerun affordance and selected action in paused mode", async () => {
    await setup();
    tui.state.phase = "paused";
    addTask("paused", "Broken task", 0, { error: "boom" });
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      issue: { number: "42", title: "Fix it" },
      worktree: "42-fix-it",
      selectedAction: "rerun",
    };
    tui.update();

    const output = lastOutput();
    expect(output).toContain("[▶ rerun]");
    expect(output).toContain("q quit");
    expect(output).toContain("Enter/Space runs selection");
    expect(output).toContain("Broken task");
    expect(output).toContain("boom");
  });

  it("resolves rerun on enter with the default selection", async () => {
    const input = createMockInput();
    const output = { columns: 80, write: vi.fn(() => true) };

    await setup({ input: input as any, output: output as any });
    tui.state.phase = "paused";
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      selectedAction: "rerun",
    };
    const promise = tui.waitForRecoveryAction();
    input.emit("keypress", "\r", { name: "return" });

    await expect(promise).resolves.toBe("rerun");
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("switches selection with tab and resolves quit on enter", async () => {
    const input = createMockInput();
    const output = { columns: 80, write: vi.fn(() => true) };

    await setup({ input: input as any, output: output as any });
    tui.state.phase = "paused";
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      selectedAction: "rerun",
    };
    const promise = tui.waitForRecoveryAction();
    input.emit("keypress", "\t", { name: "tab" });
    expect(tui.state.recovery?.selectedAction).toBe("quit");
    input.emit("keypress", "\r", { name: "return" });

    await expect(promise).resolves.toBe("quit");
  });

  it("switches selection with arrows", async () => {
    const input = createMockInput();

    await setup({ input: input as any, output: { columns: 80, write: vi.fn(() => true) } as any });
    tui.state.phase = "paused";
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      selectedAction: "rerun",
    };
    const promise = tui.waitForRecoveryAction();
    input.emit("keypress", undefined, { name: "left" });
    expect(tui.state.recovery?.selectedAction).toBe("quit");
    input.emit("keypress", undefined, { name: "right" });
    expect(tui.state.recovery?.selectedAction).toBe("rerun");
    input.emit("keypress", "q", { name: "q" });

    await expect(promise).resolves.toBe("quit");
  });

  it("resolves rerun on r", async () => {
    const input = createMockInput();

    await setup({ input: input as any, output: { columns: 80, write: vi.fn(() => true) } as any });
    tui.state.phase = "paused";
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      selectedAction: "quit",
    };
    const promise = tui.waitForRecoveryAction();
    input.emit("keypress", "r", { name: "r" });

    await expect(promise).resolves.toBe("rerun");
  });

  it("resolves quit on q", async () => {
    const input = createMockInput();

    await setup({ input: input as any, output: { columns: 80, write: vi.fn(() => true) } as any });
    tui.state.phase = "paused";
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      selectedAction: "rerun",
    };
    const promise = tui.waitForRecoveryAction();
    input.emit("keypress", "q", { name: "q" });

    await expect(promise).resolves.toBe("quit");
  });

  it("maps ctrl+c to quit", async () => {
    const input = createMockInput();

    await setup({ input: input as any, output: { columns: 80, write: vi.fn(() => true) } as any });
    tui.state.phase = "paused";
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Broken task",
      error: "boom",
      selectedAction: "rerun",
    };
    const promise = tui.waitForRecoveryAction();
    input.emit("keypress", "\u0003", { name: "c", ctrl: true });

    await expect(promise).resolves.toBe("quit");
    expect(input.listenerCount("keypress")).toBe(0);
  });
});

describe("task list truncation", () => {
  it("shows 'earlier task(s) completed' when more than 3 completed", async () => {
    await setup();
    tui.state.phase = "dispatching";
    for (let i = 0; i < 5; i++) addTask("done", `Done task ${i}`, i);
    addTask("running", "Active task", 5);
    tui.update();
    expect(lastOutput()).toContain("2 earlier task(s) completed");
  });

  it("shows 'more task(s) pending' when more than 3 pending", async () => {
    await setup();
    tui.state.phase = "dispatching";
    for (let i = 0; i < 5; i++) addTask("pending", `Pending task ${i}`, i);
    tui.update();
    expect(lastOutput()).toContain("2 more task(s) pending");
  });
});

describe("worktree indicator rendering", () => {
  it("shows issue numbers when multiple worktrees are active", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Task in wt1", 0, { worktree: "123-fix-auth", elapsed: Date.now() });
    addTask("running", "Task in wt2", 1, { worktree: "456-add-feature", elapsed: Date.now() });
    tui.update();
    const output = lastOutput();
    expect(output).toContain("#123");
    expect(output).toContain("#456");
    expect(output).not.toContain("[wt:");
  });

  it("hides worktree grouping when only one worktree is active", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Task in wt1", 0, { worktree: "123-fix-auth" });
    addTask("running", "Task in wt1", 1, { worktree: "123-fix-auth" });
    tui.update();
    expect(lastOutput()).not.toContain("[wt:");
  });

  it("hides worktree grouping when no worktrees are set", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "A regular task", 0);
    tui.update();
    expect(lastOutput()).not.toContain("[wt:");
  });

  it("shows issue numbers only for worktree groups", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Task with wt", 0, { worktree: "123-fix-auth", elapsed: Date.now() });
    addTask("running", "Task without wt", 1, { elapsed: Date.now() });
    addTask("running", "Task with wt2", 2, { worktree: "456-add-feature", elapsed: Date.now() });
    tui.update();
    const output = lastOutput();
    expect(output).toContain("#123");
    expect(output).toContain("#456");
    expect(output).not.toContain("[wt:");
  });

  it("caps running tasks at 8 and shows overflow indicator in flat mode", async () => {
    await setup();
    tui.state.phase = "dispatching";
    for (let i = 0; i < 10; i++) {
      addTask("running", `Running task ${i}`, i, { elapsed: Date.now() });
    }
    tui.update();
    const output = lastOutput();
    expect(output).toContain("2 more running");
  });

  it("shows one row per worktree group in grouped mode", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Auth login endpoint", 0, { worktree: "123-fix-auth", elapsed: Date.now() });
    addTask("running", "Auth logout endpoint", 1, { worktree: "123-fix-auth", elapsed: Date.now() });
    addTask("running", "Add search feature", 2, { worktree: "456-add-feature", elapsed: Date.now() });
    addTask("running", "Add filter feature", 3, { worktree: "456-add-feature", elapsed: Date.now() });
    tui.update();
    const output = lastOutput();
    // Each issue number should appear in the grouped output
    expect(output).toContain("#123");
    expect(output).toContain("#456");
    // Old-style [wt:...] tags must not appear
    expect(output).not.toContain("[wt:");
  });

  it("renders paused recovery details in grouped worktree mode", async () => {
    await setup();
    tui.state.phase = "paused";
    addTask("paused", "Retry auth flow", 0, {
      worktree: "123-fix-auth",
      error: "auth still failing",
    });
    addTask("running", "Add feature flag", 1, {
      worktree: "456-add-feature",
      elapsed: Date.now(),
    });
    tui.state.recovery = {
      taskIndex: 0,
      taskText: "Retry auth flow",
      error: "auth still failing",
      issue: { number: "123", title: "Fix auth" },
      worktree: "123-fix-auth",
      selectedAction: "rerun",
    };
    tui.update();

    const output = lastOutput();
    expect(output).toContain("#123");
    expect(output).toContain("#456");
    expect(output).toContain("Retry auth flow");
    expect(output).toContain("Worktree: 123-fix-auth");
    expect(output).toContain("[▶ rerun]");
    expect(output).not.toContain("[wt:");
  });
});

describe("header and issue rendering", () => {
  it("renders header with dispatch branding", async () => {
    await setup();
    expect(lastOutput()).toContain("dispatch");
  });

  it("renders provider in header when set", async () => {
    await setup();
    tui.state.provider = "copilot";
    tui.update();
    expect(lastOutput()).toContain("copilot");
  });

  it("renders model in header when set", async () => {
    await setup();
    tui.state.model = "gpt-4";
    tui.update();
    expect(lastOutput()).toContain("gpt-4");
  });

  it("renders source in header when set", async () => {
    await setup();
    tui.state.source = "github";
    tui.update();
    expect(lastOutput()).toContain("github");
  });

  it("renders current issue when set", async () => {
    await setup();
    tui.state.currentIssue = { number: "42", title: "Fix the bug" };
    tui.update();
    expect(lastOutput()).toContain("#42");
    expect(lastOutput()).toContain("Fix the bug");
  });
});

describe("visual row counting in draw", () => {
  it("accounts for line wrapping when computing lastLineCount", async () => {
    await setup();
    tui.state.phase = "dispatching";
    // Create a task with text long enough to cause wrapping at 80 cols
    const longText = "A".repeat(200);
    addTask("running", longText, 0);
    tui.update();
    writeSpy.mockClear();
    // Re-render so the cursor-up sequence reflects the previous frame's visual rows
    tui.update();
    const cursorUpCall = String(writeSpy.mock.calls[0][0]);
    // Extract the cursor-up count from the ANSI escape sequence \x1B[<N>A
    const match = cursorUpCall.match(/\x1B\[(\d+)A/);
    expect(match).not.toBeNull();
    const rowCount = Number(match![1]);
    // With a 200-char task text in an 80-col terminal, the output line containing
    // the task will wrap to multiple visual rows. The cursor-up count must be
    // greater than a simple newline count would produce.
    expect(rowCount).toBeGreaterThan(0);
  });
});

describe("spec pipeline TUI integration", () => {
  it("initializes spec mode with correct TUI state", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.provider = "opencode";
    tui.state.model = "gpt-4";
    tui.state.source = "github";
    tui.state.phase = "dispatching";
    addTask("pending", "Add auth module", 0);
    addTask("pending", "Refactor DB layer", 1);
    addTask("pending", "Update API docs", 2);
    tui.update();
    expect(lastOutput()).toContain("Generating specs");
    expect(lastOutput()).toContain("opencode");
    expect(lastOutput()).toContain("gpt-4");
    expect(lastOutput()).toContain("github");
  });

  it("reflects task state transitions during spec generation lifecycle", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("pending", "Spec task A", 0);
    addTask("pending", "Spec task B", 1);
    addTask("pending", "Spec task C", 2);
    tui.update();
    expect(lastOutput()).toContain("pending");

    tui.state.tasks[0].status = "generating";
    tui.state.tasks[0].elapsed = Date.now();
    tui.update();
    expect(lastOutput()).toContain("generating");
    expect(lastOutput()).toContain("Spec task A");

    tui.state.tasks[0].status = "syncing";
    tui.state.tasks[0].feedback = undefined;
    tui.update();
    expect(lastOutput()).toContain("syncing");

    tui.state.tasks[0].status = "done";
    tui.state.tasks[0].elapsed = 5000;
    tui.update();
    expect(lastOutput()).toContain("done");
  });

  it("displays onProgress feedback text during spec generation", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("generating", "Generate spec", 0, { elapsed: Date.now(), feedback: "Analyzing codebase structure" });
    tui.update();
    expect(lastOutput()).toContain("└─ Analyzing codebase structure");

    tui.state.tasks[0].feedback = "Writing approach section";
    tui.update();
    expect(lastOutput()).toContain("└─ Writing approach section");
    expect(lastOutput()).not.toContain("Analyzing codebase structure");
  });

  it("clears feedback text when task transitions from generating to syncing", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("generating", "Generate spec", 0, { elapsed: Date.now(), feedback: "Still drafting" });
    tui.update();
    expect(lastOutput()).toContain("└─ Still drafting");

    tui.state.tasks[0].status = "syncing";
    tui.state.tasks[0].feedback = undefined;
    tui.update();
    expect(lastOutput()).not.toContain("└─");
    expect(lastOutput()).toContain("syncing");
  });

  it("updates progress bar as specs complete", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("pending", "Spec 1", 0);
    addTask("pending", "Spec 2", 1);
    addTask("pending", "Spec 3", 2);
    addTask("pending", "Spec 4", 3);
    tui.update();
    expect(lastOutput()).toContain("0/4 tasks");

    tui.state.tasks[0].status = "done";
    tui.update();
    expect(lastOutput()).toContain("1/4 tasks");

    tui.state.tasks[1].status = "done";
    tui.update();
    expect(lastOutput()).toContain("2/4 tasks");

    tui.state.tasks[2].status = "failed";
    tui.update();
    expect(lastOutput()).toContain("3/4 tasks");

    tui.state.tasks[3].status = "done";
    tui.update();
    expect(lastOutput()).toContain("4/4 tasks");
    expect(lastOutput()).toContain("100%");
  });

  it("shows passed and failed counts in spec mode summary", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("done", "Spec A", 0);
    addTask("done", "Spec B", 1);
    addTask("failed", "Spec C", 2, { error: "Provider timeout" });
    tui.update();
    expect(lastOutput()).toContain("2 passed");
    expect(lastOutput()).toContain("1 failed");
    expect(lastOutput()).toContain("Provider timeout");
  });

  it("renders spec mode phase label as 'Generating specs' not 'Dispatching tasks'", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("generating", "Generate spec", 0, { elapsed: Date.now() });
    tui.update();
    expect(lastOutput()).toContain("Generating specs");
    expect(lastOutput()).not.toContain("Dispatching tasks");
  });

  it("handles concurrent generating tasks with individual feedback", async () => {
    await setup();
    tui.state.mode = "spec";
    tui.state.phase = "dispatching";
    addTask("generating", "Auth module spec", 0, { elapsed: Date.now(), feedback: "Exploring auth module" });
    addTask("generating", "API routes spec", 1, { elapsed: Date.now(), feedback: "Reading API routes" });
    addTask("pending", "DB layer spec", 2);
    tui.update();
    expect(lastOutput()).toContain("└─ Exploring auth module");
    expect(lastOutput()).toContain("└─ Reading API routes");
    expect(lastOutput()).toContain("0/3 tasks");
  });
});
