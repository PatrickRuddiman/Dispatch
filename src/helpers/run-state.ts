import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Task } from "../parser.js";

export interface RunStateTask {
  id: string;
  status: "pending" | "running" | "success" | "failed";
  branch?: string;
}

export interface RunState {
  runId: string;
  preRunSha: string;
  tasks: RunStateTask[];
}

const STATE_FILE = "run-state.json";
const DISPATCH_DIR = ".dispatch";

export async function loadRunState(cwd: string): Promise<RunState | null> {
  try {
    const raw = await readFile(join(cwd, DISPATCH_DIR, STATE_FILE), "utf-8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export async function saveRunState(cwd: string, state: RunState): Promise<void> {
  const dir = join(cwd, DISPATCH_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, STATE_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, target);
}

export function buildTaskId(task: Task): string {
  return `${basename(task.file)}:${task.line}`;
}

export function shouldSkipTask(taskId: string, state: RunState | null): boolean {
  if (!state) return false;
  const entry = state.tasks.find((t) => t.id === taskId);
  return entry?.status === "success";
}
