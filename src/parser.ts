/**
 * Markdown task parser — extracts unchecked `[ ]` tasks from markdown files
 * and provides utilities to mark them as complete `[x]`.
 */

import { readFile, writeFile } from "node:fs/promises";

export interface Task {
  /** Zero-based index within the file */
  index: number;
  /** The raw text after `- [ ] ` */
  text: string;
  /** Line number in the file (1-based) */
  line: number;
  /** Full original line content */
  raw: string;
  /** The source file path */
  file: string;
}

export interface TaskFile {
  path: string;
  tasks: Task[];
}

const UNCHECKED_RE = /^(\s*[-*]\s)\[ \]\s+(.+)$/;
const CHECKED_SUB = "$1[x] $2";

/**
 * Parse a single markdown file and return all unchecked tasks.
 */
export async function parseTaskFile(filePath: string): Promise<TaskFile> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const tasks: Task[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(UNCHECKED_RE);
    if (match) {
      tasks.push({
        index: tasks.length,
        text: match[2].trim(),
        line: i + 1,
        raw: lines[i],
        file: filePath,
      });
    }
  }

  return { path: filePath, tasks };
}

/**
 * Mark a specific task as complete in its source file by replacing `[ ]` with `[x]`.
 */
export async function markTaskComplete(task: Task): Promise<void> {
  const content = await readFile(task.file, "utf-8");
  const lines = content.split("\n");
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
  await writeFile(task.file, lines.join("\n"), "utf-8");
}
