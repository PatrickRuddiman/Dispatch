/**
 * Shared formatting utilities used across the CLI.
 */

import chalk from "chalk";

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * Examples:
 *   elapsed(0)       → "0s"
 *   elapsed(45000)   → "45s"
 *   elapsed(133000)  → "2m 13s"
 */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Options for the shared header renderer. */
export interface HeaderInfo {
  provider?: string;
  model?: string;
  source?: string;
}

/**
 * Build the standard dispatch header lines used by both the TUI and
 * the spec-generation banner.
 *
 * Returns an array of chalk-formatted strings (one per line).
 * Each metadata field (provider, model, source) is rendered on its own line.
 */
export function renderHeaderLines(info: HeaderInfo): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold.white("  ⚡ dispatch") + chalk.dim(` — AI task orchestration`));
  if (info.provider) {
    lines.push(chalk.dim(`  provider: ${info.provider}`));
  }
  if (info.model) {
    lines.push(chalk.dim(`  model: ${info.model}`));
  }
  if (info.source) {
    lines.push(chalk.dim(`  source: ${info.source}`));
  }
  return lines;
}
