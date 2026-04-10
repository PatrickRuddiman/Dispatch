/**
 * Markdown task parser — extracts unchecked `[ ]` tasks from markdown files
 * and provides utilities to mark them as complete `[x]`.
 *
 * Non-task content (headings, prose, notes) is preserved in `TaskFile.context`
 * so the planner can use it for implementation guidance.
 */

import { readFile, writeFile } from "node:fs/promises";

export interface Task {
  /** Zero-based index within the file */
  index: number;
  /** The raw text after `- [ ] `, with any (P)/(S) prefix stripped */
  text: string;
  /** Line number in the file (1-based) */
  line: number;
  /** Full original line content */
  raw: string;
  /** The source file path */
  file: string;
  /** Execution mode — "parallel", "serial", or "isolated". Defaults to "serial" when unspecified. */
  mode?: "parallel" | "serial" | "isolated";
}

export interface TaskFile {
  path: string;
  tasks: Task[];
  /** Full file content — includes non-task prose, headings, and notes */
  content: string;
}

/** Matches an unchecked markdown task item, e.g. `- [ ] Implement feature` */
const UNCHECKED_RE = /^(\s*[-*]\s)\[ \]\s+(.+)$/;
/** Matches a checked markdown task item, e.g. `- [x] Implement feature` */
const CHECKED_RE = /^(\s*[-*]\s)\[[xX]\]\s+/;
/** Replacement string used with UNCHECKED_RE to mark a task complete, e.g. `- [ ] task` → `- [x] task` */
const CHECKED_SUB = "$1[x] $2";
/** Matches a mode prefix at the start of task text, e.g. `(P) Run tests in parallel` */
const MODE_PREFIX_RE = /^\(([PSI])\)\s+/;

/**
 * Build a filtered view of the file content for a single task's planner context.
 * Keeps:
 *   - All non-task lines (headings, prose, notes, blank lines, checked tasks)
 *   - The specific unchecked task line being planned
 * Removes:
 *   - All *other* unchecked `[ ]` task lines
 *
 * This prevents the planner (and downstream executor) from being confused
 * by sibling tasks that belong to different agents.
 */
export function buildTaskContext(content: string, task: Task): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const filtered = lines.filter((line, i) => {
    // Always keep the line that matches the current task
    if (i + 1 === task.line) return true;
    // Remove other unchecked task lines
    if (UNCHECKED_RE.test(line)) return false;
    // Keep everything else (headings, prose, checked tasks, blank lines)
    return true;
  });

  return filtered.join("\n");
}

/**
 * Parse markdown content (string) and return all unchecked tasks.
 * Pure function — no file I/O. Useful for testing and reuse.
 */
export function parseTaskContent(content: string, filePath: string): TaskFile {
  // Normalize CRLF → LF so the regex anchors work consistently
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const tasks: Task[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(UNCHECKED_RE);
    if (match) {
      let text = match[2].trim();
      let mode: "parallel" | "serial" | "isolated" = "serial";

      const modeMatch = text.match(MODE_PREFIX_RE);
      if (modeMatch) {
        const modeMap: Record<string, "parallel" | "serial" | "isolated"> = {
          P: "parallel",
          S: "serial",
          I: "isolated",
        };
        mode = modeMap[modeMatch[1]] ?? "serial";
        text = text.slice(modeMatch[0].length);
      }

      tasks.push({
        index: tasks.length,
        text,
        line: i + 1,
        raw: lines[i],
        file: filePath,
        mode,
      });
    }
  }

  return { path: filePath, tasks, content };
}

/**
 * Parse a single markdown file and return all unchecked tasks.
 */
export async function parseTaskFile(filePath: string): Promise<TaskFile> {
  const content = await readFile(filePath, "utf-8");
  return parseTaskContent(content, filePath);
}

/**
 * Mark a specific task as complete in its source file by replacing `[ ]` with `[x]`.
 */
export async function markTaskComplete(task: Task): Promise<void> {
  const content = await readFile(task.file, "utf-8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const lineIndex = task.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(
      `Line ${task.line} out of range in ${task.file} (${lines.length} lines)`
    );
  }

  const original = lines[lineIndex];
  const updated = original.replace(UNCHECKED_RE, CHECKED_SUB);

  if (original === updated) {
    throw new Error(
      `Line ${task.line} in ${task.file} does not match expected unchecked pattern: "${original}"`
    );
  }

  lines[lineIndex] = updated;
  await writeFile(task.file, lines.join(eol), "utf-8");
}

/**
 * Group a flat task list into ordered execution groups.
 *
 * - Consecutive parallel tasks accumulate into the current group.
 * - A serial task caps the current group (is appended to it), then a new group begins.
 * - A lone serial task (no preceding parallel tasks) forms a solo group.
 * - An isolated task flushes the current group (if non-empty) as its own group,
 *   then creates a solo group containing only the isolated task, then resets
 *   the accumulator. This guarantees the isolated task runs alone.
 *
 * The orchestrator runs each group concurrently, waiting for the group to
 * complete before starting the next one.
 */
export function groupTasksByMode(tasks: Task[]): Task[][] {
  if (tasks.length === 0) return [];

  const groups: Task[][] = [];
  let current: Task[] = [];

  for (const task of tasks) {
    const mode = task.mode ?? "serial";

    if (mode === "parallel") {
      current.push(task);
    } else if (mode === "isolated") {
      // Flush accumulated tasks as their own group
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      // Push a solo group for the isolated task
      groups.push([task]);
    } else {
      // Serial task caps the current group
      current.push(task);
      groups.push(current);
      current = [];
    }
  }

  // Flush any remaining parallel tasks that weren't capped by a serial task
  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}
