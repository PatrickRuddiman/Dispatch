/**
 * Shared formatting utilities used across the CLI.
 */

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
