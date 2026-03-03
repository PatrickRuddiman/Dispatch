/**
 * Generic retry utility.
 *
 * Provides a reusable `withRetry` wrapper that retries an async function
 * on any thrown error up to a configurable number of times. Used by the
 * dispatch pipeline to add resilience to agent calls.
 */

import { log } from "./logger.js";

/** Options for `withRetry`. */
export interface RetryOptions {
  /** Label for log messages identifying the operation being retried. */
  label?: string;
}

/**
 * Retry an async function up to `maxRetries` times on failure.
 *
 * Calls `fn` and returns its result on the first success. If `fn` throws,
 * it is retried up to `maxRetries` additional times. If all attempts fail,
 * the last error is re-thrown.
 *
 * @param fn         - Async function to execute (called with no arguments)
 * @param maxRetries - Number of retry attempts (0 = no retries, 1 = one retry, etc.)
 * @param options    - Optional label for log output
 * @returns The resolved value of `fn`
 * @throws The last error if all attempts are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = maxRetries + 1;
  const label = options?.label;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const suffix = label ? ` [${label}]` : "";
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
