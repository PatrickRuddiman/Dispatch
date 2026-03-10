/**
 * TUI renderer — draws a real-time dashboard to the terminal showing
 * dispatch progress, current task, and results.
 */

import chalk from "chalk";
import { elapsed, renderHeaderLines } from "./helpers/format.js";
import type { Task } from "./parser.js";

export type TaskStatus = "pending" | "planning" | "running" | "generating" | "syncing" | "done" | "failed";

export interface TaskState {
  task: Task;
  status: TaskStatus;
  elapsed?: number;
  error?: string;
  feedback?: string;
  /** Worktree directory name when running in a worktree (e.g. "123-fix-auth-bug") */
  worktree?: string;
}

export interface TuiState {
  tasks: TaskState[];
  phase: "discovering" | "parsing" | "booting" | "dispatching" | "done";
  mode?: "dispatch" | "spec";
  startTime: number;
  filesFound: number;
  serverUrl?: string;
  /** Active provider name — shown in the booting phase */
  provider?: string;
  /** Model identifier reported by the provider, if available */
  model?: string;
  /** Datasource name (e.g. "github", "azdevops", "md") */
  source?: string;
  /** Currently-processing issue context (number + title) */
  currentIssue?: { number: string; title: string };
  /** Persistent notification banner (e.g. auth device-code prompt) */
  notification?: string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 30;

let spinnerIndex = 0;
let interval: ReturnType<typeof setInterval> | null = null;
let lastLineCount = 0;

function spinner(): string {
  return chalk.cyan(SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]);
}

function progressBar(done: number, total: number): string {
  if (total === 0) return chalk.dim("░".repeat(BAR_WIDTH));
  const filled = Math.round((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const pct = Math.round((done / total) * 100);
  return (
    chalk.green("█".repeat(filled)) +
    chalk.dim("░".repeat(empty)) +
    chalk.white(` ${pct}%`)
  );
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return chalk.dim("○");
    case "planning":
      return spinner();
    case "running":
    case "generating":
    case "syncing":
      return spinner();
    case "done":
      return chalk.green("●");
    case "failed":
      return chalk.red("✖");
  }
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return chalk.dim("pending");
    case "planning":
      return chalk.magenta("planning");
    case "running":
      return chalk.cyan("executing");
    case "generating":
      return chalk.cyan("generating");
    case "syncing":
      return chalk.cyan("syncing");
    case "done":
      return chalk.green("done");
    case "failed":
      return chalk.red("failed");
  }
}

function phaseLabel(phase: TuiState["phase"], provider?: string, mode: TuiState["mode"] = "dispatch"): string {
  switch (phase) {
    case "discovering":
      return `${spinner()} Discovering task files...`;
    case "parsing":
      return `${spinner()} Parsing tasks...`;
    case "booting": {
      const name = provider ?? "provider";
      return `${spinner()} Connecting to ${name}...`;
    }
    case "dispatching":
      return mode === "spec" ? `${spinner()} Generating specs...` : `${spinner()} Dispatching tasks...`;
    case "done":
      return chalk.green("✔") + " Complete";
  }
}

function isActiveStatus(status: TaskStatus): boolean {
  return status === "planning" || status === "running" || status === "generating" || status === "syncing";
}

function sanitizeSubordinateText(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function renderTaskError(error?: string): string | null {
  if (!error) return null;
  return chalk.red(`       └─ ${error}`);
}

function renderTaskFeedback(feedback: string | undefined, cols: number): string | null {
  if (!feedback) return null;
  const sanitized = sanitizeSubordinateText(feedback);
  if (!sanitized) return null;
  const maxLen = Math.max(16, cols - 10);
  return chalk.dim(`       └─ ${truncateText(sanitized, maxLen)}`);
}

function countVisualRows(text: string, cols: number): number {
  const stripped = text.replace(/\x1B\[[0-9;]*m/g, "");
  const safeCols = Math.max(1, cols);
  return stripped.split("\n").reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(line.length / safeCols));
  }, 0);
}

function render(state: TuiState): string {
  const lines: string[] = [];
  const now = Date.now();
  const totalElapsed = elapsed(now - state.startTime);

  const done = state.tasks.filter((t) => t.status === "done").length;
  const failed = state.tasks.filter((t) => t.status === "failed").length;
  const total = state.tasks.length;

  // ── Header ──────────────────────────────────────────────────
  lines.push("");
  lines.push(
    ...renderHeaderLines({
      provider: state.provider,
      model: state.model,
      source: state.source,
    })
  );

  if (state.currentIssue) {
    lines.push(
      chalk.dim(`  issue: `) + chalk.white(`#${state.currentIssue.number}`) + chalk.dim(` — ${state.currentIssue.title}`)
    );
  }

  lines.push(chalk.dim("  ─".repeat(24)));

  // ── Notification banner (auth prompts, etc.) ─────────────
  if (state.notification) {
    lines.push("");
    for (const notifLine of state.notification.split("\n")) {
      lines.push("  " + chalk.yellowBright("⚠ ") + chalk.yellow(notifLine));
    }
  }

  // ── Phase + Timer ───────────────────────────────────────────
  lines.push(`  ${phaseLabel(state.phase, state.provider, state.mode)}` + chalk.dim(`  ${totalElapsed}`));

  if (state.phase === "dispatching" || state.phase === "done") {
    // ── Progress bar ────────────────────────────────────────
    lines.push("");
    lines.push(`  ${progressBar(done + failed, total)}  ${chalk.dim(`${done + failed}/${total} tasks`)}`);
    lines.push("");

    // ── Task list ───────────────────────────────────────────
    // Determine if multiple worktrees are active (show indicator only when >1)
    const activeWorktrees = new Set(
      state.tasks.map((t) => t.worktree).filter(Boolean)
    );
    const showWorktree = activeWorktrees.size > 1;

    const cols = process.stdout.columns || 80;
    const maxTextLen = cols - 30;

    const running = state.tasks.filter((t) => isActiveStatus(t.status));
    const completed = state.tasks.filter(
      (t) => t.status === "done" || t.status === "failed"
    );
    const pending = state.tasks.filter((t) => t.status === "pending");

    if (showWorktree) {
      // ── Grouped-by-worktree display ───────────────────────
      const groups = new Map<string, TaskState[]>();
      const ungrouped: TaskState[] = [];
      for (const ts of state.tasks) {
        if (ts.worktree) {
          const arr = groups.get(ts.worktree) ?? [];
          arr.push(ts);
          groups.set(ts.worktree, arr);
        } else {
          ungrouped.push(ts);
        }
      }

      const doneGroups: [string, TaskState[]][] = [];
      const activeGroups: [string, TaskState[]][] = [];
      for (const [wt, tasks] of groups) {
        const allDone = tasks.every((t) => t.status === "done" || t.status === "failed");
        if (allDone) {
          doneGroups.push([wt, tasks]);
        } else {
          activeGroups.push([wt, tasks]);
        }
      }

      // Done groups (collapsed, last 3)
      if (doneGroups.length > 3) {
        lines.push(chalk.dim(`  ··· ${doneGroups.length - 3} earlier issue(s) completed`));
      }
      for (const [wt, tasks] of doneGroups.slice(-3)) {
        const issueNum = wt.match(/^(\d+)/)?.[1] ?? wt.slice(0, 12);
        const anyFailed = tasks.some((t) => t.status === "failed");
        const icon = anyFailed ? chalk.red("✖") : chalk.green("●");
        const doneCount = tasks.filter((t) => t.status === "done").length;
        const maxElapsed = Math.max(...tasks.map((t) => t.elapsed ?? 0));
        lines.push(`  ${icon} ${chalk.dim(`#${issueNum}`)}  ${chalk.dim(`${doneCount}/${tasks.length} tasks`)}  ${chalk.dim(elapsed(maxElapsed))}`);
      }

      // Active groups (one row per group)
      for (const [wt, tasks] of activeGroups) {
        const issueNum = wt.match(/^(\d+)/)?.[1] ?? wt.slice(0, 12);
        const activeTasks = tasks.filter((t) => isActiveStatus(t.status));
        const activeCount = activeTasks.length;
        const firstActive = activeTasks[0];
        const truncLen = Math.min(cols - 26, 60);
        let text = firstActive?.task.text ?? "";
        if (text.length > truncLen) {
          text = text.slice(0, truncLen - 1) + "…";
        }
        const earliest = Math.min(...activeTasks.map((t) => t.elapsed ?? now));
        const elapsedStr = elapsed(now - earliest);
        lines.push(`  ${spinner()} ${chalk.white(`#${issueNum}`)}  ${activeCount} active  ${text}  ${chalk.dim(elapsedStr)}`);
      }

      // Ungrouped tasks (only running/planning, flat)
      for (const ts of ungrouped) {
        if (!isActiveStatus(ts.status)) continue;
        const icon = statusIcon(ts.status);
        const idx = chalk.dim(`#${state.tasks.indexOf(ts) + 1}`);
        const text = truncateText(ts.task.text, maxTextLen);
        const elapsedStr = chalk.dim(` ${elapsed(now - (ts.elapsed || now))}`);
        const label = statusLabel(ts.status);
        lines.push(`  ${icon} ${idx} ${text} ${label}${elapsedStr}`);
        const feedbackLine = ts.status === "generating" ? renderTaskFeedback(ts.feedback, cols) : null;
        if (feedbackLine) {
          lines.push(feedbackLine);
        }
        const errorLine = renderTaskError(ts.error);
        if (errorLine) {
          lines.push(errorLine);
        }
      }
    } else {
      // ── Flat display with running cap ─────────────────────
      const visibleRunning = running.slice(0, 8);
      const visible: TaskState[] = [
        ...completed.slice(-3),
        ...visibleRunning,
        ...pending.slice(0, 3),
      ];

      if (completed.length > 3) {
        lines.push(chalk.dim(`  ··· ${completed.length - 3} earlier task(s) completed`));
      }

      for (const ts of visible) {
        const icon = statusIcon(ts.status);
        const idx = chalk.dim(`#${state.tasks.indexOf(ts) + 1}`);
        const text = truncateText(ts.task.text, maxTextLen);

        const elapsedStr =
          isActiveStatus(ts.status)
            ? chalk.dim(` ${elapsed(now - (ts.elapsed || now))}`)
            : ts.status === "done" && ts.elapsed
              ? chalk.dim(` ${elapsed(ts.elapsed)}`)
              : "";

        const label = statusLabel(ts.status);

        lines.push(`  ${icon} ${idx} ${text} ${label}${elapsedStr}`);

        const feedbackLine = ts.status === "generating" ? renderTaskFeedback(ts.feedback, cols) : null;
        if (feedbackLine) {
          lines.push(feedbackLine);
        }

        const errorLine = renderTaskError(ts.error);
        if (errorLine) {
          lines.push(errorLine);
        }
      }

      if (running.length > 8) {
        lines.push(chalk.dim(`  ··· ${running.length - 8} more running`));
      }

      if (pending.length > 3) {
        lines.push(chalk.dim(`  ··· ${pending.length - 3} more task(s) pending`));
      }
    }

    // ── Summary line ────────────────────────────────────────
    lines.push("");
    const parts: string[] = [];
    if (done > 0) parts.push(chalk.green(`${done} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (total - done - failed > 0)
      parts.push(chalk.dim(`${total - done - failed} remaining`));
    lines.push(`  ${parts.join(chalk.dim(" · "))}`);
  } else if (state.filesFound > 0) {
    lines.push(chalk.dim(`  Found ${state.filesFound} file(s)`));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Clear the previous render and draw a new frame.
 * Uses a single-write, per-line overwrite strategy to eliminate flicker.
 */
function draw(state: TuiState): void {
  const output = render(state);
  const cols = process.stdout.columns || 80;
  const newLineCount = countVisualRows(output, cols);

  let buffer = "";

  // Move cursor up to the beginning of the previous frame
  if (lastLineCount > 0) {
    buffer += `\x1B[${lastLineCount}A`;
  }

  // Append each line with \x1B[K (Erase to End of Line)
  const lines = output.split("\n");
  buffer += lines.map((line) => line + "\x1B[K").join("\n");

  // Clean up leftover rows if new frame is shorter than previous
  const leftover = lastLineCount - newLineCount;
  if (leftover > 0) {
    for (let i = 0; i < leftover; i++) {
      buffer += "\n\x1B[K";
    }
    buffer += `\x1B[${leftover}A`;
  }

  process.stdout.write(buffer);
  lastLineCount = newLineCount;
}

/**
 * Create and start the TUI — returns a controller to update state.
 */
export function createTui(): {
  state: TuiState;
  update: () => void;
  stop: () => void;
} {
  const state: TuiState = {
    tasks: [],
    phase: "discovering",
    mode: "dispatch",
    startTime: Date.now(),
    filesFound: 0,
  };

  // Animate spinner at ~80ms
  interval = setInterval(() => {
    spinnerIndex++;
    draw(state);
  }, 80);

  const update = () => draw(state);

  const stop = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    draw(state);
  };

  draw(state);

  return { state, update, stop };
}
