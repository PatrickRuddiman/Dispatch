/**
 * Generic async retry utility.
 *
 * Provides a reusable `withRetry` wrapper that re-executes a failing async
 * operation up to a configurable number of times.  Each retry attempt is
 * logged via the structured `log` helper so operators can observe transient
 * failures in verbose mode.  If every attempt fails the **last** error is
 * re-thrown so callers see the most recent failure context.
 */

import { log } from "./logger.js";

/** Options accepted by {@link withRetry}. */
export interface RetryOptions {
  /** Human-readable label included in log messages (e.g. `"planner.plan()"`). */
  label?: string;
}

/**
 * Retry an async operation up to `maxAttempts` times.
 *
 * The `fn` callback is invoked on each attempt.  If it resolves, the value
 * is returned immediately.  If it rejects, the error is caught and — unless
 * the maximum number of attempts has been reached — `fn` is called again.
 *
 * When all attempts are exhausted the **last** error thrown by `fn` is
 * re-thrown to the caller.
 *
 * @param fn          - A zero-argument async function to execute (and potentially retry)
 * @param maxAttempts - Total number of attempts (must be ≥ 1)
 * @param options     - Optional settings (label for log messages)
 * @returns The resolved value of `fn`
 * @throws The last error thrown by `fn` if all attempts fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  options?: RetryOptions,
): Promise<T> {
  const label = options?.label;
  const suffix = label ? ` [${label}]` : "";

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt < maxAttempts) {
        log.warn(
          `Attempt ${attempt}/${maxAttempts} failed${suffix}: ${log.extractMessage(err)}`,
        );
        log.debug(`Retrying${suffix} (attempt ${attempt + 1}/${maxAttempts})`);
      }
    }
  }

  throw lastError;
}
