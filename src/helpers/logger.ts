/**
 * Minimal structured logger for CLI output.
 *
 * Set `log.verbose = true` to enable `log.debug()` output. The `--verbose`
 * CLI flag controls this at startup.
 */

import chalk from "chalk";

export const log = {
  /** When true, `debug()` messages are printed. Set by `--verbose`. */
  verbose: false,

  info(msg: string) {
    console.log(chalk.blue("ℹ"), msg);
  },
  success(msg: string) {
    console.log(chalk.green("✔"), msg);
  },
  warn(msg: string) {
    console.log(chalk.yellow("⚠"), msg);
  },
  error(msg: string) {
    console.error(chalk.red("✖"), msg);
  },
  task(index: number, total: number, msg: string) {
    console.log(chalk.cyan(`[${index + 1}/${total}]`), msg);
  },
  dim(msg: string) {
    console.log(chalk.dim(msg));
  },

  /**
   * Print a debug/verbose message. Only visible when `log.verbose` is true.
   * Messages are prefixed with a dim arrow to visually nest them under the
   * preceding info/error line.
   */
  debug(msg: string) {
    if (!this.verbose) return;
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

    while (current && depth < 5) {
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
