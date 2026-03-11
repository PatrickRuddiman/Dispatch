/**
 * TUI renderer — draws a real-time dashboard to the terminal showing
 * dispatch progress, current task, and results.
 */

import chalk from "chalk";
import { emitKeypressEvents } from "node:readline";
import { elapsed, renderHeaderLines } from "./helpers/format.js";
import type { Task } from "./parser.js";

export type TaskStatus = "pending" | "planning" | "running" | "paused" | "done" | "failed";
type RecoveryAction = "rerun" | "quit";

export interface TaskState {
  task: Task;
  status: TaskStatus;
  elapsed?: number;
  error?: string;
  /** Worktree directory name when running in a worktree (e.g. "123-fix-auth-bug") */
  worktree?: string;
}

export interface TuiRecoveryState {
  taskIndex: number;
  taskText: string;
  error: string;
  issue?: { number: string; title: string };
  worktree?: string;
  selectedAction: RecoveryAction;
}

export interface TuiState {
  tasks: TaskState[];
  phase: "discovering" | "parsing" | "booting" | "dispatching" | "paused" | "done";
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
  recovery?: TuiRecoveryState;
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
      return spinner();
    case "paused":
      return chalk.yellow("◐");
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
    case "paused":
      return chalk.yellow("paused");
    case "done":
      return chalk.green("done");
    case "failed":
      return chalk.red("failed");
  }
}

function phaseLabel(phase: TuiState["phase"], provider?: string): string {
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
      return `${spinner()} Dispatching tasks...`;
    case "paused":
      return chalk.yellow("◐") + " Waiting for rerun...";
    case "done":
      return chalk.green("✔") + " Complete";
  }
}

function countVisualRows(text: string, cols: number): number {
  const stripped = text.replace(/\x1B\[[0-9;]*m/g, "");
  const safeCols = Math.max(1, cols);
  return stripped.split("\n").reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(line.length / safeCols));
  }, 0);
}

function toggleRecoveryAction(action: RecoveryAction): RecoveryAction {
  return action === "rerun" ? "quit" : "rerun";
}

function renderRecoveryAction(action: RecoveryAction, selectedAction: RecoveryAction): string {
  const selected = action === selectedAction;
  if (action === "rerun") {
    return selected ? chalk.greenBright(`[▶ rerun]`) : chalk.dim("▶ rerun");
  }
  return selected ? chalk.redBright("[q quit]") : chalk.dim("q quit");
}

function render(state: TuiState, cols: number): string {
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
  lines.push(`  ${phaseLabel(state.phase, state.provider)}` + chalk.dim(`  ${totalElapsed}`));

  if (state.phase === "dispatching" || state.phase === "paused" || state.phase === "done") {
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

    const maxTextLen = cols - 30;

    const paused = state.tasks.filter((t) => t.status === "paused");
    const running = state.tasks.filter((t) => t.status === "running" || t.status === "planning");
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
        const activeTasks = tasks.filter((t) => t.status === "running" || t.status === "planning" || t.status === "paused");
        const activeCount = activeTasks.length;
        const firstActive = activeTasks[0];
        const truncLen = Math.min(cols - 26, 60);
        let text = firstActive?.task.text ?? "";
        if (text.length > truncLen) {
          text = text.slice(0, truncLen - 1) + "…";
        }
        const earliest = Math.min(...activeTasks.map((t) => t.elapsed ?? now));
        const elapsedStr = elapsed(now - earliest);
        lines.push(`  ${statusIcon(firstActive?.status ?? "pending")} ${chalk.white(`#${issueNum}`)}  ${activeCount} active  ${text}  ${chalk.dim(elapsedStr)}`);
      }

      // Ungrouped tasks (only running/planning, flat)
      for (const ts of ungrouped) {
        if (ts.status !== "running" && ts.status !== "planning" && ts.status !== "paused") continue;
        const icon = statusIcon(ts.status);
        const idx = chalk.dim(`#${state.tasks.indexOf(ts) + 1}`);
        let text = ts.task.text;
        if (text.length > maxTextLen) {
          text = text.slice(0, maxTextLen - 1) + "…";
        }
        const elapsedStr = chalk.dim(` ${elapsed(now - (ts.elapsed || now))}`);
        const label = statusLabel(ts.status);
        lines.push(`  ${icon} ${idx} ${text} ${label}${elapsedStr}`);
        if (ts.error) {
          lines.push(chalk.red(`       └─ ${ts.error}`));
        }
      }
    } else {
      // ── Flat display with running cap ─────────────────────
      const visibleRunning = running.slice(0, 8);
      const visible: TaskState[] = [
        ...completed.slice(-3),
        ...paused.slice(0, 3),
        ...visibleRunning,
        ...pending.slice(0, 3),
      ];

      if (completed.length > 3) {
        lines.push(chalk.dim(`  ··· ${completed.length - 3} earlier task(s) completed`));
      }

      for (const ts of visible) {
        const icon = statusIcon(ts.status);
        const idx = chalk.dim(`#${state.tasks.indexOf(ts) + 1}`);
        let text = ts.task.text;
        if (text.length > maxTextLen) {
          text = text.slice(0, maxTextLen - 1) + "…";
        }

        const elapsedStr =
          ts.status === "running" || ts.status === "planning"
            ? chalk.dim(` ${elapsed(now - (ts.elapsed || now))}`)
            : ts.status === "done" && ts.elapsed
              ? chalk.dim(` ${elapsed(ts.elapsed)}`)
              : "";

        const label = statusLabel(ts.status);

        lines.push(`  ${icon} ${idx} ${text} ${label}${elapsedStr}`);

        if (ts.error) {
          lines.push(chalk.red(`       └─ ${ts.error}`));
        }
      }

      if (running.length > 8) {
        lines.push(chalk.dim(`  ··· ${running.length - 8} more running`));
      }

      if (pending.length > 3) {
        lines.push(chalk.dim(`  ··· ${pending.length - 3} more task(s) pending`));
      }
    }

    if (state.phase === "paused" && state.recovery) {
      const selectedAction = state.recovery.selectedAction ?? "rerun";
      lines.push("");
      lines.push(`  ${chalk.yellow("Recovery")}: ${chalk.white(`#${state.recovery.taskIndex + 1}`)} ${state.recovery.taskText}`);
      lines.push(`  ${chalk.red(state.recovery.error)}`);
      if (state.recovery.issue) {
        lines.push(`  ${chalk.dim(`Issue #${state.recovery.issue.number} - ${state.recovery.issue.title}`)}`);
      }
      if (state.recovery.worktree) {
        lines.push(`  ${chalk.dim(`Worktree: ${state.recovery.worktree}`)}`);
      }
      lines.push(`  ${chalk.red("✖")} ${renderRecoveryAction("rerun", selectedAction)}  ${renderRecoveryAction("quit", selectedAction)}`);
      lines.push(`  ${chalk.dim("Tab/←/→ switch · Enter/Space runs selection · r reruns · q quits")}`);
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
  drawToOutput(state, process.stdout);
}

function drawToOutput(
  state: TuiState,
  output: Pick<NodeJS.WriteStream, "write"> & { columns?: number },
): void {
  const cols = output.columns || 80;
  const rendered = render(state, cols);
  const newLineCount = countVisualRows(rendered, cols);

  let buffer = "";

  // Move cursor up to the beginning of the previous frame
  if (lastLineCount > 0) {
    buffer += `\x1B[${lastLineCount}A`;
  }

  // Append each line with \x1B[K (Erase to End of Line)
  const lines = rendered.split("\n");
  buffer += lines.map((line) => line + "\x1B[K").join("\n");

  // Clean up leftover rows if new frame is shorter than previous
  const leftover = lastLineCount - newLineCount;
  if (leftover > 0) {
    for (let i = 0; i < leftover; i++) {
      buffer += "\n\x1B[K";
    }
    buffer += `\x1B[${leftover}A`;
  }

  output.write(buffer);
  lastLineCount = newLineCount;
}

/**
 * Create and start the TUI — returns a controller to update state.
 */
export function createTui(options?: {
  input?: NodeJS.ReadStream;
  output?: Pick<NodeJS.WriteStream, "write"> & { columns?: number };
}): {
  state: TuiState;
  update: () => void;
  stop: () => void;
  waitForRecoveryAction: () => Promise<RecoveryAction>;
} {
  const input = options?.input ?? process.stdin;
  const output = options?.output ?? process.stdout;
  const state: TuiState = {
    tasks: [],
    phase: "discovering",
    startTime: Date.now(),
    filesFound: 0,
  };
  let activeRecoveryPromise: Promise<RecoveryAction> | null = null;
  let cleanupRecoveryPrompt: (() => void) | null = null;

  // Animate spinner at ~80ms
  interval = setInterval(() => {
    spinnerIndex++;
    drawToOutput(state, output);
  }, 80);

  const update = () => drawToOutput(state, output);

  const waitForRecoveryAction = () => {
    if (activeRecoveryPromise) {
      return activeRecoveryPromise;
    }

    activeRecoveryPromise = new Promise<RecoveryAction>((resolve) => {
      const ttyInput = input as NodeJS.ReadStream & {
        isRaw?: boolean;
        isTTY?: boolean;
        setRawMode?: (mode: boolean) => void;
      };
      const wasRaw = ttyInput.isRaw ?? false;
      const canToggleRawMode = ttyInput.isTTY === true && typeof ttyInput.setRawMode === "function";
      if (state.recovery) {
        state.recovery.selectedAction = state.recovery.selectedAction ?? "rerun";
        drawToOutput(state, output);
      }

      emitKeypressEvents(input);
      if (canToggleRawMode) {
        ttyInput.setRawMode!(true);
      }

      const finish = (action: RecoveryAction) => {
        cleanupRecoveryPrompt?.();
        resolve(action);
      };

      const updateSelection = (nextAction: RecoveryAction) => {
        if (!state.recovery || state.recovery.selectedAction === nextAction) {
          return;
        }
        state.recovery.selectedAction = nextAction;
        drawToOutput(state, output);
      };

      const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        const name = key?.name ?? str;
        if (key?.ctrl && name === "c") {
          finish("quit");
          return;
        }
        if (name === "r" || name === "R") {
          finish("rerun");
          return;
        }
        if (name === "q" || name === "Q") {
          finish("quit");
          return;
        }
        if (name === "tab" || name === "left" || name === "right") {
          updateSelection(toggleRecoveryAction(state.recovery?.selectedAction ?? "rerun"));
          return;
        }
        if (name === "return" || name === "enter" || name === "space" || str === " ") {
          finish(state.recovery?.selectedAction ?? "rerun");
        }
      };

      cleanupRecoveryPrompt = () => {
        input.off("keypress", onKeypress);
        if (canToggleRawMode) {
          ttyInput.setRawMode!(wasRaw);
        }
        cleanupRecoveryPrompt = null;
        activeRecoveryPromise = null;
      };

      input.on("keypress", onKeypress);
    });

    return activeRecoveryPromise;
  };

  const stop = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (activeRecoveryPromise) {
      cleanupRecoveryPrompt?.();
    }
    drawToOutput(state, output);
  };

  drawToOutput(state, output);

  return { state, update, stop, waitForRecoveryAction };
}
