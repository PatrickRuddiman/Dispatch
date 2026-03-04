/**
 * Per-issue file logger for detailed, structured log output.
 *
 * Writes timestamped, plain-text log entries to `.dispatch/logs/issue-{id}.log`.
 * Each log line is prefixed with an ISO 8601 timestamp. The logger provides
 * standard level methods (`info`, `debug`, `warn`, `error`) plus structured
 * methods for prompts, responses, phase transitions, and agent lifecycle events.
 *
 * An `AsyncLocalStorage<FileLogger>` instance is exported for scoping file
 * loggers to async contexts, allowing each issue processed in parallel to
 * maintain its own log file without threading parameters through call stacks.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export const fileLoggerStorage = new AsyncLocalStorage<FileLogger>();

export class FileLogger {
  readonly filePath: string;

  private static sanitizeIssueId(issueId: string | number): string {
    const raw = String(issueId);
    return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  constructor(issueId: string | number, cwd: string) {
    const safeIssueId = FileLogger.sanitizeIssueId(issueId);
    this.filePath = join(cwd, ".dispatch", "logs", `issue-${safeIssueId}.log`);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, "", "utf-8");
  }

  private write(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    appendFileSync(this.filePath, line, "utf-8");
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  debug(message: string): void {
    this.write("DEBUG", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  success(message: string): void {
    this.write("SUCCESS", message);
  }

  task(message: string): void {
    this.write("TASK", message);
  }

  dim(message: string): void {
    this.write("DIM", message);
  }

  prompt(label: string, content: string): void {
    const separator = "─".repeat(40);
    this.write("PROMPT", `${label}\n${separator}\n${content}\n${separator}`);
  }

  response(label: string, content: string): void {
    const separator = "─".repeat(40);
    this.write("RESPONSE", `${label}\n${separator}\n${content}\n${separator}`);
  }

  phase(name: string): void {
    const banner = "═".repeat(40);
    this.write("PHASE", `${banner}\n${name}\n${banner}`);
  }

  agentEvent(agent: string, event: string, detail?: string): void {
    const msg = detail ? `[${agent}] ${event}: ${detail}` : `[${agent}] ${event}`;
    this.write("AGENT", msg);
  }

  close(): void {
    // no-op for sync writes; provides a cleanup hook for future use
  }
}
