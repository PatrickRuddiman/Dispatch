import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "../parser.js";

let writeSpy: ReturnType<typeof vi.spyOn>;
let tui: { state: import("../tui.js").TuiState; update: () => void; stop: () => void };

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
async function setup() {
  const mod = await import("../tui.js");
  tui = mod.createTui();
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
  });

  it("update() triggers a re-render", async () => {
    await setup();
    writeSpy.mockClear();
    tui.update();
    expect(writeSpy).toHaveBeenCalled();
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
  });

  it("spinner animates on interval ticks", async () => {
    await setup();
    const callsBefore = writeSpy.mock.calls.length;
    vi.advanceTimersByTime(80);
    expect(writeSpy.mock.calls.length).toBeGreaterThan(callsBefore);
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
  it("shows worktree tag when multiple worktrees are active", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Task in wt1", 0, { worktree: "123-fix-auth" });
    addTask("running", "Task in wt2", 1, { worktree: "456-add-feature" });
    tui.update();
    const output = lastOutput();
    expect(output).toContain("[wt:123-fix-auth]");
    expect(output).toContain("[wt:456-add-feature]");
  });

  it("hides worktree tag when only one worktree is active", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Task in wt1", 0, { worktree: "123-fix-auth" });
    addTask("running", "Task in wt1", 1, { worktree: "123-fix-auth" });
    tui.update();
    expect(lastOutput()).not.toContain("[wt:");
  });

  it("hides worktree tag when no worktrees are set", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "A regular task", 0);
    tui.update();
    expect(lastOutput()).not.toContain("[wt:");
  });

  it("shows worktree tag only for tasks that have a worktree", async () => {
    await setup();
    tui.state.phase = "dispatching";
    addTask("running", "Task with wt", 0, { worktree: "123-fix-auth" });
    addTask("running", "Task without wt", 1);
    addTask("running", "Task with wt2", 2, { worktree: "456-add-feature" });
    tui.update();
    const output = lastOutput();
    expect(output).toContain("[wt:123-fix-auth]");
    expect(output).toContain("[wt:456-add-feature]");
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
