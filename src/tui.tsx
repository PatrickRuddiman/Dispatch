/**
 * TUI renderer — Ink (React for CLI) based real-time dashboard showing
 * dispatch progress, current task, and results.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, Spacer, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import { elapsed } from "./helpers/format.js";
import type { Task } from "./parser.js";

// ── Types ─────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "planning" | "running" | "generating" | "syncing" | "paused" | "done" | "failed";
type RecoveryAction = "rerun" | "quit";

export interface TaskState {
  task: Task;
  status: TaskStatus;
  elapsed?: number;
  error?: string;
  feedback?: string;
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
  mode?: "dispatch" | "spec";
  startTime: number;
  filesFound: number;
  serverUrl?: string;
  provider?: string;
  model?: string;
  source?: string;
  currentIssue?: { number: string; title: string };
  notification?: string;
  recovery?: TuiRecoveryState;
}

// ── Color Palette ─────────────────────────────────────────────────

const PALETTE = {
  brand: "#58A6FF",
  subtitle: "#484F58",
  chrome: "#30363D",
  text: "#C9D1D9",
  muted: "#484F58",
  success: "#56D364",
  error: "#F85149",
  warn: "#D29922",
  accent: "#79C0FF",
  planning: "#D2A8FF",
};

// ── Helpers ───────────────────────────────────────────────────────

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

// ── Components ────────────────────────────────────────────────────

function Header({ provider, model, source, currentIssue }: {
  provider?: string;
  model?: string;
  source?: string;
  currentIssue?: { number: string; title: string };
}) {
  const metaParts: string[] = [];
  if (provider) metaParts.push(`provider: ${provider}`);
  if (model) metaParts.push(`model: ${model}`);
  if (source) metaParts.push(`source: ${source}`);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={PALETTE.chrome} paddingLeft={1} paddingRight={1}>
      <Text bold color={PALETTE.brand}>⚡ dispatch</Text>
      <Text color={PALETTE.subtitle}>AI task orchestration</Text>
      {metaParts.length > 0 && (
        <>
          <Box marginTop={0}>
            <Text color={PALETTE.chrome}>{"─".repeat(60)}</Text>
          </Box>
          <Text color={PALETTE.text}>{metaParts.join("  ·  ")}</Text>
        </>
      )}
      {currentIssue && (
        <Text>
          <Text color={PALETTE.muted}>issue: </Text>
          <Text color="white">#{currentIssue.number}</Text>
          <Text color={PALETTE.muted}> — {currentIssue.title}</Text>
        </Text>
      )}
    </Box>
  );
}

function NotificationBanner({ notification }: { notification?: string }) {
  if (!notification) return null;
  return (
    <Box marginLeft={2} marginTop={1}>
      <Text color={PALETTE.warn}>⚠ {notification}</Text>
    </Box>
  );
}

function PhaseLabel({ phase, provider, mode, startTime }: {
  phase: TuiState["phase"];
  provider?: string;
  mode?: TuiState["mode"];
  startTime: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const totalElapsed = elapsed(now - startTime);
  let label: string;
  let showSpinner = false;

  switch (phase) {
    case "discovering":
      label = "Discovering task files";
      showSpinner = true;
      break;
    case "parsing":
      label = "Parsing tasks";
      showSpinner = true;
      break;
    case "booting":
      label = `Connecting to ${provider ?? "provider"}`;
      showSpinner = true;
      break;
    case "dispatching":
      label = mode === "spec" ? "Generating specs" : "Dispatching tasks";
      showSpinner = true;
      break;
    case "paused":
      label = "Waiting for rerun";
      break;
    case "done":
      label = "Complete";
      break;
    default:
      label = phase;
  }

  return (
    <Box marginLeft={2} marginTop={1}>
      {showSpinner ? (
        <Text color={PALETTE.accent}><Spinner type="dots" /> </Text>
      ) : phase === "paused" ? (
        <Text color={PALETTE.warn}>◐ </Text>
      ) : phase === "done" ? (
        <Text color={PALETTE.success}>✔ </Text>
      ) : null}
      <Text>{label}</Text>
      <Spacer />
      <Text color={PALETTE.muted}>{totalElapsed}</Text>
    </Box>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const BAR_WIDTH = 30;
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Box marginLeft={2} marginTop={1}>
      <Text color={PALETTE.muted}>▐</Text>
      <Text color={PALETTE.success}>{"█".repeat(filled)}</Text>
      <Text color={PALETTE.muted}>{"░".repeat(empty)}</Text>
      <Text color={PALETTE.muted}>▌</Text>
      <Text> {pct}%   {done}/{total} tasks</Text>
    </Box>
  );
}

function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case "pending":
      return <Text color={PALETTE.muted}>○</Text>;
    case "planning":
      return <Text color={PALETTE.planning}><Spinner type="dots" /></Text>;
    case "running":
    case "generating":
    case "syncing":
      return <Text color={PALETTE.accent}><Spinner type="dots" /></Text>;
    case "paused":
      return <Text color={PALETTE.warn}>◐</Text>;
    case "done":
      return <Text color={PALETTE.success}>●</Text>;
    case "failed":
      return <Text color={PALETTE.error}>✖</Text>;
    default:
      return <Text color={PALETTE.muted}>{status}</Text>;
  }
}

function statusLabelText(status: TaskStatus): { text: string; color: string } {
  switch (status) {
    case "pending": return { text: "pending", color: PALETTE.muted };
    case "planning": return { text: "planning", color: PALETTE.planning };
    case "running": return { text: "executing", color: PALETTE.accent };
    case "generating": return { text: "generating", color: PALETTE.accent };
    case "syncing": return { text: "syncing", color: PALETTE.accent };
    case "paused": return { text: "paused", color: PALETTE.warn };
    case "done": return { text: "done", color: PALETTE.success };
    case "failed": return { text: "failed", color: PALETTE.error };
    default: return { text: status, color: PALETTE.muted };
  }
}

function TaskRow({ ts, index, totalTasks }: { ts: TaskState; index: number; totalTasks: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (isActiveStatus(ts.status)) {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }
  }, [ts.status]);

  const { text: labelText, color: labelColor } = statusLabelText(ts.status);
  const elapsedStr = isActiveStatus(ts.status)
    ? elapsed(now - (ts.elapsed || now))
    : ts.status === "done" && ts.elapsed
      ? elapsed(ts.elapsed)
      : "";

  const isDone = ts.status === "done" || ts.status === "failed";
  const textColor = isDone ? PALETTE.muted : PALETTE.text;

  return (
    <Box flexDirection="column">
      <Box marginLeft={4}>
        <StatusIcon status={ts.status} />
        <Text color={PALETTE.muted}>  #{index + 1}  </Text>
        <Text color={textColor}>{truncateText(ts.task.text, 50)}</Text>
        <Spacer />
        <Text color={labelColor}>{labelText}</Text>
        {elapsedStr ? <Text color={PALETTE.muted}>  {elapsedStr}</Text> : null}
      </Box>
      {ts.status === "generating" && ts.feedback && (
        <Box marginLeft={11}>
          <Text color={PALETTE.muted}>└─ {truncateText(sanitizeSubordinateText(ts.feedback), 60)}</Text>
        </Box>
      )}
      {ts.error && (
        <Box marginLeft={11}>
          <Text color={PALETTE.error}>└─ {ts.error}</Text>
        </Box>
      )}
    </Box>
  );
}

function TaskList({ tasks, phase }: { tasks: TaskState[]; phase: TuiState["phase"] }) {
  if (phase !== "dispatching" && phase !== "paused" && phase !== "done") return null;

  const activeWorktrees = new Set(tasks.map((t) => t.worktree).filter(Boolean));
  const showWorktree = activeWorktrees.size > 1;

  if (showWorktree) {
    return <WorktreeGroupedList tasks={tasks} />;
  }

  return <FlatTaskList tasks={tasks} />;
}

function FlatTaskList({ tasks }: { tasks: TaskState[] }) {
  const paused = tasks.filter((t) => t.status === "paused");
  const running = tasks.filter((t) => isActiveStatus(t.status));
  const completed = tasks.filter((t) => t.status === "done" || t.status === "failed");
  const pending = tasks.filter((t) => t.status === "pending");

  const visibleRunning = running.slice(0, 8);
  const visible: TaskState[] = [
    ...completed.slice(-3),
    ...paused.slice(0, 3),
    ...visibleRunning,
    ...pending.slice(0, 3),
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      {completed.length > 3 && (
        <Box marginLeft={4}>
          <Text color={PALETTE.muted}>··· {completed.length - 3} earlier task(s) completed</Text>
        </Box>
      )}
      {visible.map((ts) => {
        const idx = tasks.indexOf(ts);
        return <TaskRow key={idx} ts={ts} index={idx} totalTasks={tasks.length} />;
      })}
      {running.length > 8 && (
        <Box marginLeft={4}>
          <Text color={PALETTE.muted}>··· {running.length - 8} more running</Text>
        </Box>
      )}
      {pending.length > 3 && (
        <Box marginLeft={4}>
          <Text color={PALETTE.muted}>··· {pending.length - 3} more task(s) pending</Text>
        </Box>
      )}
    </Box>
  );
}

function WorktreeGroupedList({ tasks }: { tasks: TaskState[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const groups = new Map<string, TaskState[]>();
  const ungrouped: TaskState[] = [];
  for (const ts of tasks) {
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
  for (const [wt, wtTasks] of groups) {
    const allDone = wtTasks.every((t) => t.status === "done" || t.status === "failed");
    if (allDone) {
      doneGroups.push([wt, wtTasks]);
    } else {
      activeGroups.push([wt, wtTasks]);
    }
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {doneGroups.length > 3 && (
        <Box marginLeft={4}>
          <Text color={PALETTE.muted}>··· {doneGroups.length - 3} earlier issue(s) completed</Text>
        </Box>
      )}
      {doneGroups.slice(-3).map(([wt, wtTasks]) => {
        const issueNum = wt.match(/^(\d+)/)?.[1] ?? wt.slice(0, 12);
        const anyFailed = wtTasks.some((t) => t.status === "failed");
        const doneCount = wtTasks.filter((t) => t.status === "done").length;
        const maxElapsed = Math.max(...wtTasks.map((t) => t.elapsed ?? 0));
        return (
          <Box key={wt} marginLeft={4}>
            {anyFailed
              ? <Text color={PALETTE.error}>✖</Text>
              : <Text color={PALETTE.success}>●</Text>}
            <Text color={PALETTE.muted}>  #{issueNum}  {doneCount}/{wtTasks.length} tasks  {elapsed(maxElapsed)}</Text>
          </Box>
        );
      })}
      {activeGroups.map(([wt, wtTasks]) => {
        const issueNum = wt.match(/^(\d+)/)?.[1] ?? wt.slice(0, 12);
        const activeTasks = wtTasks.filter((t) => isActiveStatus(t.status) || t.status === "paused");
        const firstActive = activeTasks[0];
        const displayStatus = firstActive?.status ?? "pending";
        const text = firstActive?.task.text ?? wtTasks[0]?.task.text ?? "";
        const earliest = activeTasks.length > 0
          ? Math.min(...activeTasks.map((t) => t.elapsed ?? now))
          : now;
        const elapsedStr = elapsed(now - earliest);
        const countLabel = activeTasks.length > 0
          ? `${activeTasks.length} active`
          : `${wtTasks.length} pending`;
        return (
          <Box key={wt} marginLeft={4}>
            <StatusIcon status={displayStatus} />
            <Text color="white">  #{issueNum}  </Text>
            <Text>{countLabel}  {truncateText(text, 40)}</Text>
            <Spacer />
            <Text color={PALETTE.muted}>{elapsedStr}</Text>
          </Box>
        );
      })}
      {ungrouped.filter((ts) => isActiveStatus(ts.status) || ts.status === "paused").map((ts) => {
        const idx = tasks.indexOf(ts);
        return <TaskRow key={idx} ts={ts} index={idx} totalTasks={tasks.length} />;
      })}
    </Box>
  );
}

function RecoveryPrompt({ recovery, onAction }: {
  recovery: TuiRecoveryState;
  onAction: (action: RecoveryAction) => void;
}) {
  const [selected, setSelected] = useState<RecoveryAction>(recovery.selectedAction);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onAction("quit");
      return;
    }
    if (input === "r" || input === "R") {
      onAction("rerun");
      return;
    }
    if (input === "q" || input === "Q") {
      onAction("quit");
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      setSelected((prev) => (prev === "rerun" ? "quit" : "rerun"));
      return;
    }
    if (key.return || input === " ") {
      onAction(selected);
    }
  });

  // Keep external state in sync
  useEffect(() => {
    if (recovery.selectedAction !== selected) {
      recovery.selectedAction = selected;
    }
  }, [selected]);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1} borderStyle="round" borderColor={PALETTE.error} paddingLeft={1} paddingRight={1}>
      <Box>
        <Text color={PALETTE.warn}>Recovery: </Text>
        <Text color="white">#{recovery.taskIndex + 1} </Text>
        <Text>{recovery.taskText}</Text>
      </Box>
      <Text color={PALETTE.error}>{recovery.error}</Text>
      {recovery.issue && (
        <Text color={PALETTE.muted}>Issue #{recovery.issue.number} - {recovery.issue.title}</Text>
      )}
      {recovery.worktree && (
        <Text color={PALETTE.muted}>Worktree: {recovery.worktree}</Text>
      )}
      <Box marginTop={1}>
        <Text color={PALETTE.error}>✖ </Text>
        {selected === "rerun"
          ? <Text color={PALETTE.success} bold>[▶ rerun]</Text>
          : <Text color={PALETTE.muted}>▶ rerun</Text>}
        <Text>  </Text>
        {selected === "quit"
          ? <Text color={PALETTE.error} bold>[q quit]</Text>
          : <Text color={PALETTE.muted}>q quit</Text>}
      </Box>
      <Text color={PALETTE.muted}>Tab/←/→ switch · Enter/Space runs selection · r reruns · q quits</Text>
    </Box>
  );
}

function Summary({ tasks }: { tasks: TaskState[] }) {
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const remaining = tasks.length - done - failed;

  if (tasks.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Text color={PALETTE.chrome}>{"─".repeat(60)}</Text>
      <Box>
        {done > 0 && <Text color={PALETTE.success}>{done} passed</Text>}
        {done > 0 && (failed > 0 || remaining > 0) && <Text color={PALETTE.muted}> · </Text>}
        {failed > 0 && <Text color={PALETTE.error}>{failed} failed</Text>}
        {failed > 0 && remaining > 0 && <Text color={PALETTE.muted}> · </Text>}
        {remaining > 0 && <Text color={PALETTE.muted}>{remaining} remaining</Text>}
      </Box>
    </Box>
  );
}

function FilesFound({ count, phase }: { count: number; phase: TuiState["phase"] }) {
  if (phase === "dispatching" || phase === "paused" || phase === "done" || count === 0) return null;
  return (
    <Box marginLeft={2}>
      <Text color={PALETTE.muted}>Found {count} file(s)</Text>
    </Box>
  );
}

// ── Main App Component ────────────────────────────────────────────

interface AppProps {
  stateRef: React.MutableRefObject<TuiState>;
  onRecoveryAction?: (action: RecoveryAction) => void;
}

function App({ stateRef, onRecoveryAction }: AppProps) {
  const [state, setState] = useState<TuiState>(stateRef.current);

  // Expose setState for external callers
  useEffect(() => {
    (stateRef as any).__setState = setState;
  }, []);

  const s = state;
  const showProgress = s.phase === "dispatching" || s.phase === "paused" || s.phase === "done";
  const done = s.tasks.filter((t) => t.status === "done").length;
  const failed = s.tasks.filter((t) => t.status === "failed").length;

  return (
    <Box flexDirection="column">
      <Header
        provider={s.provider}
        model={s.model}
        source={s.source}
        currentIssue={s.currentIssue}
      />
      <NotificationBanner notification={s.notification} />
      <PhaseLabel phase={s.phase} provider={s.provider} mode={s.mode} startTime={s.startTime} />
      {showProgress && (
        <>
          <ProgressBar done={done + failed} total={s.tasks.length} />
          <TaskList tasks={s.tasks} phase={s.phase} />
          {s.phase === "paused" && s.recovery && onRecoveryAction && (
            <RecoveryPrompt recovery={s.recovery} onAction={onRecoveryAction} />
          )}
          <Summary tasks={s.tasks} />
        </>
      )}
      <FilesFound count={s.filesFound} phase={s.phase} />
    </Box>
  );
}

// ── Public API ────────────────────────────────────────────────────

export function createTui(options?: {
  input?: NodeJS.ReadStream;
  output?: Pick<NodeJS.WriteStream, "write"> & { columns?: number };
}): {
  state: TuiState;
  update: () => void;
  stop: () => void;
  waitForRecoveryAction: () => Promise<RecoveryAction>;
} {
  const state: TuiState = {
    tasks: [],
    phase: "discovering",
    mode: "dispatch",
    startTime: Date.now(),
    filesFound: 0,
  };

  const stateRef = { current: state } as React.MutableRefObject<TuiState> & {
    __setState?: React.Dispatch<React.SetStateAction<TuiState>>;
  };

  let recoveryResolver: ((action: RecoveryAction) => void) | null = null;
  let activeRecoveryPromise: Promise<RecoveryAction> | null = null;

  const onRecoveryAction = (action: RecoveryAction) => {
    if (recoveryResolver) {
      recoveryResolver(action);
      recoveryResolver = null;
      activeRecoveryPromise = null;
    }
  };

  // Use Ink only when explicitly requested AND in a real TTY terminal.
  // Default to plain text renderer for backward compat (tests, non-TTY, verbose).
  const useInk = !options?.output && !options?.input
    && process.stdout.isTTY === true
    && !process.env.VITEST;

  let inkInstance: ReturnType<typeof render> | null = null;

  const plainOutput = options?.output ?? process.stdout;

  let plainInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerIndex = 0;
  let lastLineCount = 0;

  if (useInk) {
    // Real terminal rendering with Ink
    inkInstance = render(
      <App stateRef={stateRef} onRecoveryAction={onRecoveryAction} />,
      {
        stdout: process.stdout,
        stdin: options?.input ?? process.stdin,
      },
    );
  } else {
    // Plain text renderer for tests, non-TTY, verbose mode
    renderPlainText(state, plainOutput);
  }

  if (!useInk) {
    const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    plainInterval = setInterval(() => {
      spinnerIndex++;
      renderPlainText(state, plainOutput, SPINNER_FRAMES, spinnerIndex);
    }, 80);
  }

  function renderPlainText(
    s: TuiState,
    output: Pick<NodeJS.WriteStream, "write"> & { columns?: number },
    frames: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    sIdx: number = 0,
  ) {
    const cols = output.columns || 80;
    const sp = frames[sIdx % frames.length];
    const lines: string[] = [];
    const now = Date.now();

    // Header
    lines.push("");
    lines.push(`  ⚡ dispatch — AI task orchestration`);
    if (s.provider) lines.push(`  provider: ${s.provider}`);
    if (s.model) lines.push(`  model: ${s.model}`);
    if (s.source) lines.push(`  source: ${s.source}`);
    if (s.currentIssue) lines.push(`  issue: #${s.currentIssue.number} — ${s.currentIssue.title}`);
    lines.push(`  ${"─".repeat(48)}`);

    // Notification
    if (s.notification) {
      lines.push("");
      for (const l of s.notification.split("\n")) lines.push(`  ⚠ ${l}`);
    }

    // Phase
    const totalElapsed = elapsed(now - s.startTime);
    switch (s.phase) {
      case "discovering": lines.push(`  ${sp} Discovering task files...  ${totalElapsed}`); break;
      case "parsing": lines.push(`  ${sp} Parsing tasks...  ${totalElapsed}`); break;
      case "booting": lines.push(`  ${sp} Connecting to ${s.provider ?? "provider"}...  ${totalElapsed}`); break;
      case "dispatching": lines.push(`  ${sp} ${s.mode === "spec" ? "Generating specs" : "Dispatching tasks"}...  ${totalElapsed}`); break;
      case "paused": lines.push(`  ◐ Waiting for rerun...  ${totalElapsed}`); break;
      case "done": lines.push(`  ✔ Complete  ${totalElapsed}`); break;
    }

    const showProgress = s.phase === "dispatching" || s.phase === "paused" || s.phase === "done";

    if (showProgress) {
      const done = s.tasks.filter((t) => t.status === "done").length;
      const failed = s.tasks.filter((t) => t.status === "failed").length;
      const total = s.tasks.length;
      const BAR_WIDTH = 30;
      const filled = total === 0 ? 0 : Math.round(((done + failed) / total) * BAR_WIDTH);
      const empty = BAR_WIDTH - filled;
      const pct = total === 0 ? 0 : Math.round(((done + failed) / total) * 100);

      lines.push("");
      lines.push(`  ${"█".repeat(filled)}${"░".repeat(empty)}  ${pct}%  ${done + failed}/${total} tasks`);
      lines.push("");

      // Task list
      const activeWorktrees = new Set(s.tasks.map((t) => t.worktree).filter(Boolean));
      const showWorktree = activeWorktrees.size > 1;
      const maxTextLen = cols - 30;

      if (showWorktree) {
        const groups = new Map<string, TaskState[]>();
        const ungrouped: TaskState[] = [];
        for (const ts of s.tasks) {
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
          if (tasks.every((t) => t.status === "done" || t.status === "failed")) {
            doneGroups.push([wt, tasks]);
          } else {
            activeGroups.push([wt, tasks]);
          }
        }
        if (doneGroups.length > 3) {
          lines.push(`  ··· ${doneGroups.length - 3} earlier issue(s) completed`);
        }
        for (const [wt, tasks] of doneGroups.slice(-3)) {
          const issueNum = wt.match(/^(\d+)/)?.[1] ?? wt.slice(0, 12);
          const anyFailed = tasks.some((t) => t.status === "failed");
          const icon = anyFailed ? "✖" : "●";
          const doneCount = tasks.filter((t) => t.status === "done").length;
          const maxEl = Math.max(...tasks.map((t) => t.elapsed ?? 0));
          lines.push(`  ${icon} #${issueNum}  ${doneCount}/${tasks.length} tasks  ${elapsed(maxEl)}`);
        }
        for (const [wt, tasks] of activeGroups) {
          const issueNum = wt.match(/^(\d+)/)?.[1] ?? wt.slice(0, 12);
          const activeTasks = tasks.filter((t) => isActiveStatus(t.status) || t.status === "paused");
          const firstActive = activeTasks[0];
          const displayStatus = firstActive?.status ?? "pending";
          let text = firstActive?.task.text ?? tasks[0]?.task.text ?? "";
          if (text.length > 60) text = text.slice(0, 59) + "…";
          const earliest = activeTasks.length > 0 ? Math.min(...activeTasks.map((t) => t.elapsed ?? now)) : now;
          const elapsedStr = elapsed(now - earliest);
          const countLabel = activeTasks.length > 0 ? `${activeTasks.length} active` : `${tasks.length} pending`;
          const sIcon = displayStatus === "pending" ? "○"
            : displayStatus === "done" ? "●"
            : displayStatus === "failed" ? "✖"
            : displayStatus === "paused" ? "◐"
            : sp;
          lines.push(`  ${sIcon} #${issueNum}  ${countLabel}  ${text}  ${elapsedStr}`);
        }
        for (const ts of ungrouped) {
          if (!isActiveStatus(ts.status) && ts.status !== "paused") continue;
          const idx = s.tasks.indexOf(ts);
          const icon = isActiveStatus(ts.status) ? sp : ts.status === "paused" ? "◐" : "○";
          const text = truncateText(ts.task.text, maxTextLen);
          const elapsedStr = isActiveStatus(ts.status) ? ` ${elapsed(now - (ts.elapsed || now))}` : "";
          const label = statusLabelPlain(ts.status);
          lines.push(`  ${icon} #${idx + 1} ${text} ${label}${elapsedStr}`);
          if (ts.status === "generating" && ts.feedback) {
            const sanitized = sanitizeSubordinateText(ts.feedback);
            if (sanitized) lines.push(`       └─ ${truncateText(sanitized, Math.max(16, cols - 10))}`);
          }
          if (ts.error) lines.push(`       └─ ${ts.error}`);
        }
      } else {
        const paused = s.tasks.filter((t) => t.status === "paused");
        const running = s.tasks.filter((t) => isActiveStatus(t.status));
        const completed = s.tasks.filter((t) => t.status === "done" || t.status === "failed");
        const pending = s.tasks.filter((t) => t.status === "pending");
        const visibleRunning = running.slice(0, 8);
        const visible = [...completed.slice(-3), ...paused.slice(0, 3), ...visibleRunning, ...pending.slice(0, 3)];

        if (completed.length > 3) lines.push(`  ··· ${completed.length - 3} earlier task(s) completed`);

        for (const ts of visible) {
          const idx = s.tasks.indexOf(ts);
          const icon = ts.status === "done" ? "●"
            : ts.status === "failed" ? "✖"
            : ts.status === "paused" ? "◐"
            : ts.status === "pending" ? "○"
            : sp;
          const text = truncateText(ts.task.text, maxTextLen);
          const elapsedStr = isActiveStatus(ts.status)
            ? ` ${elapsed(now - (ts.elapsed || now))}`
            : ts.status === "done" && ts.elapsed ? ` ${elapsed(ts.elapsed)}` : "";
          const label = statusLabelPlain(ts.status);
          lines.push(`  ${icon} #${idx + 1} ${text} ${label}${elapsedStr}`);
          if (ts.status === "generating" && ts.feedback) {
            const sanitized = sanitizeSubordinateText(ts.feedback);
            if (sanitized) lines.push(`       └─ ${truncateText(sanitized, Math.max(16, cols - 10))}`);
          }
          if (ts.error) lines.push(`       └─ ${ts.error}`);
        }

        if (running.length > 8) lines.push(`  ··· ${running.length - 8} more running`);
        if (pending.length > 3) lines.push(`  ··· ${pending.length - 3} more task(s) pending`);
      }

      // Recovery
      if (s.phase === "paused" && s.recovery) {
        const sel = s.recovery.selectedAction ?? "rerun";
        lines.push("");
        lines.push(`  Recovery: #${s.recovery.taskIndex + 1} ${s.recovery.taskText}`);
        lines.push(`  ${s.recovery.error}`);
        if (s.recovery.issue) lines.push(`  Issue #${s.recovery.issue.number} - ${s.recovery.issue.title}`);
        if (s.recovery.worktree) lines.push(`  Worktree: ${s.recovery.worktree}`);
        const rerunLabel = sel === "rerun" ? "[▶ rerun]" : "▶ rerun";
        const quitLabel = sel === "quit" ? "[q quit]" : "q quit";
        lines.push(`  ✖ ${rerunLabel}  ${quitLabel}`);
        lines.push(`  Tab/←/→ switch · Enter/Space runs selection · r reruns · q quits`);
      }

      // Summary
      lines.push("");
      const parts: string[] = [];
      const doneCount = s.tasks.filter((t) => t.status === "done").length;
      const failedCount = s.tasks.filter((t) => t.status === "failed").length;
      if (doneCount > 0) parts.push(`${doneCount} passed`);
      if (failedCount > 0) parts.push(`${failedCount} failed`);
      if (s.tasks.length - doneCount - failedCount > 0) parts.push(`${s.tasks.length - doneCount - failedCount} remaining`);
      lines.push(`  ${parts.join(" · ")}`);
    } else if (s.filesFound > 0) {
      lines.push(`  Found ${s.filesFound} file(s)`);
    }

    lines.push("");
    const rendered = lines.join("\n");

    // ANSI cursor control for in-place updates
    const newLineCount = countVisualRows(rendered, cols);
    let buffer = "";
    if (lastLineCount > 0) buffer += `\x1B[${lastLineCount}A`;
    buffer += rendered.split("\n").map((line) => line + "\x1B[K").join("\n");
    const leftover = lastLineCount - newLineCount;
    if (leftover > 0) {
      for (let i = 0; i < leftover; i++) buffer += "\n\x1B[K";
      buffer += `\x1B[${leftover}A`;
    }
    output.write(buffer);
    lastLineCount = newLineCount;
  }

  function countVisualRows(text: string, cols: number): number {
    const stripped = text.replace(/\x1B\[[0-9;]*m/g, "");
    const safeCols = Math.max(1, cols);
    return stripped.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / safeCols)), 0);
  }

  function statusLabelPlain(status: TaskStatus): string {
    switch (status) {
      case "pending": return "pending";
      case "planning": return "planning";
      case "running": return "executing";
      case "generating": return "generating";
      case "syncing": return "syncing";
      case "paused": return "paused";
      case "done": return "done";
      case "failed": return "failed";
      default: return status;
    }
  }

  const update = () => {
    if (!useInk) {
      renderPlainText(state, plainOutput, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], spinnerIndex);
    } else if ((stateRef as any).__setState) {
      // Trigger React re-render by creating a new state snapshot
      (stateRef as any).__setState({ ...state });
    }
  };

  const stop = () => {
    if (plainInterval) {
      clearInterval(plainInterval);
      plainInterval = null;
    }
    if (!useInk) {
      renderPlainText(state, plainOutput, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], spinnerIndex);
    }
    if (inkInstance) {
      inkInstance.unmount();
      inkInstance = null;
    }
  };

  const waitForRecoveryAction = (): Promise<RecoveryAction> => {
    if (activeRecoveryPromise) return activeRecoveryPromise;

    if (!useInk) {
      // For test/custom output: use raw keypress handling (same as old TUI)
      const input = options?.input ?? process.stdin;
      activeRecoveryPromise = new Promise<RecoveryAction>((resolve) => {
        const { emitKeypressEvents } = require("node:readline");
        const ttyInput = input as NodeJS.ReadStream & {
          isRaw?: boolean;
          isTTY?: boolean;
          setRawMode?: (mode: boolean) => void;
        };
        const wasRaw = ttyInput.isRaw ?? false;
        const canToggleRawMode = ttyInput.isTTY === true && typeof ttyInput.setRawMode === "function";
        if (state.recovery) {
          state.recovery.selectedAction = state.recovery.selectedAction ?? "rerun";
          update();
        }

        emitKeypressEvents(input);
        if (canToggleRawMode) {
          (ttyInput.setRawMode as (mode: boolean) => void)(true);
        }

        let cleanupFn: (() => void) | null = null;

        const finish = (action: RecoveryAction) => {
          cleanupFn?.();
          resolve(action);
        };

        const updateSelection = (nextAction: RecoveryAction) => {
          if (!state.recovery || state.recovery.selectedAction === nextAction) return;
          state.recovery.selectedAction = nextAction;
          update();
        };

        const toggleAction = (current: RecoveryAction): RecoveryAction =>
          current === "rerun" ? "quit" : "rerun";

        const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
          const name = key?.name ?? str;
          if (key?.ctrl && name === "c") { finish("quit"); return; }
          if (name === "r" || name === "R") { finish("rerun"); return; }
          if (name === "q" || name === "Q") { finish("quit"); return; }
          if (name === "tab" || name === "left" || name === "right") {
            updateSelection(toggleAction(state.recovery?.selectedAction ?? "rerun"));
            return;
          }
          if (name === "return" || name === "enter" || name === "space" || str === " ") {
            finish(state.recovery?.selectedAction ?? "rerun");
          }
        };

        cleanupFn = () => {
          input.off("keypress", onKeypress);
          if (canToggleRawMode) {
            (ttyInput.setRawMode as (mode: boolean) => void)(wasRaw);
          }
          cleanupFn = null;
          activeRecoveryPromise = null;
        };

        input.on("keypress", onKeypress);
      });
      return activeRecoveryPromise;
    }

    // For Ink mode: use promise that resolves via onRecoveryAction callback
    activeRecoveryPromise = new Promise<RecoveryAction>((resolve) => {
      recoveryResolver = resolve;
    });
    update();
    return activeRecoveryPromise;
  };

  return { state, update, stop, waitForRecoveryAction };
}
