/**
 * Minimal structured logger for CLI output.
 *
 * Log verbosity is controlled by (in priority order):
 *   1. `LOG_LEVEL` env var — one of `"debug"`, `"info"`, `"warn"`, `"error"`
 *   2. `DEBUG` env var — any truthy value sets the level to `"debug"`
 *   3. `log.verbose = true` / the `--verbose` CLI flag (maps to `"debug"`)
 *   4. Default: `"info"`
 */

import chalk from "chalk";

/** Supported log levels, ordered from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Resolve the effective log level from environment variables.
 * Priority: LOG_LEVEL > DEBUG > default ("info").
 */
function resolveLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_SEVERITY) {
    return envLevel as LogLevel;
  }
  if (process.env.DEBUG) {
    return "debug";
  }
  return "info";
}

/** Current effective log level. */
let currentLevel: LogLevel = resolveLogLevel();

/** Returns the current effective log level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[currentLevel];
}

/** Maximum depth to traverse when unwinding nested error `.cause` chains. */
const MAX_CAUSE_CHAIN_DEPTH = 5;

export const log = {
  verbose: false as boolean,

  info(msg: string) {
    if (!shouldLog("info")) return;
    console.log(chalk.blue("ℹ"), msg);
  },
  success(msg: string) {
    if (!shouldLog("info")) return;
    console.log(chalk.green("✔"), msg);
  },
  warn(msg: string) {
    if (!shouldLog("warn")) return;
    console.error(chalk.yellow("⚠"), msg);
  },
  error(msg: string) {
    if (!shouldLog("error")) return;
    console.error(chalk.red("✖"), msg);
  },
  task(index: number, total: number, msg: string) {
    if (!shouldLog("info")) return;
    console.log(chalk.cyan(`[${index + 1}/${total}]`), msg);
  },
  dim(msg: string) {
    if (!shouldLog("info")) return;
    console.log(chalk.dim(msg));
  },

  /**
   * Print a debug/verbose message. Only visible when the log level is
   * `"debug"`. Messages are prefixed with a dim arrow to visually nest
   * them under the preceding info/error line.
   */
  debug(msg: string) {
    if (!shouldLog("debug")) return;
    console.log(chalk.dim(`  ⤷ ${msg}`));
  },

  /**
   * Extract and format the full error cause chain. Node.js network errors
   * (e.g. `TypeError: fetch failed`) bury the real reason in nested `.cause`
   * properties — this helper surfaces them all.
   */
  formatErrorChain(err: unknown): string {
    const parts: string[] = [];
    let current: unknown = err;
    let depth = 0;

    while (current && depth < MAX_CAUSE_CHAIN_DEPTH) {
      if (current instanceof Error) {
        const prefix = depth === 0 ? "Error" : "Cause";
        parts.push(`${prefix}: ${current.message}`);
        if (current.cause) {
          current = current.cause;
        } else {
          break;
        }
      } else {
        parts.push(`${depth === 0 ? "Error" : "Cause"}: ${String(current)}`);
        break;
      }
      depth++;
    }

    return parts.join("\n  ⤷ ");
  },

  /**
   * Extract the raw error message string from an unknown thrown value.
   * Returns `err.message` for Error instances, `String(err)` for other
   * truthy values, and `""` for null/undefined.
   */
  extractMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err != null) return String(err);
    return "";
  },
};

Object.defineProperty(log, "verbose", {
  get(): boolean {
    return currentLevel === "debug";
  },
  set(value: boolean) {
    currentLevel = value ? "debug" : "info";
  },
  enumerable: true,
  configurable: true,
});
