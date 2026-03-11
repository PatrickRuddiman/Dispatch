/**
 * Generic promise timeout utility.
 *
 * Provides a reusable `withTimeout` wrapper that races a promise against
 * a `setTimeout` rejection. Used by the dispatch pipeline to bound
 * planning and execution durations. Timeout failures are distinguished
 * from other errors via the custom `TimeoutError` class.
 */

/**
 * Thrown when a `withTimeout` call exceeds the specified duration.
 *
 * The `label` property (if set) identifies which operation timed out,
 * making log output and error messages more diagnosable.
 */
export class TimeoutError extends Error {
  /** Optional label identifying the operation that timed out. */
  readonly label?: string;

  constructor(ms: number, label?: string) {
    const suffix = label ? ` [${label}]` : "";
    super(`Timed out after ${ms}ms${suffix}`);
    this.name = "TimeoutError";
    this.label = label;
  }
}

/** Default planning timeout in minutes when not specified by the user. */
export const DEFAULT_PLAN_TIMEOUT_MIN = 15;

/**
 * Race a promise against a timeout.
 *
 * If the promise resolves or rejects before `ms` milliseconds, its
 * result is returned (or its error re-thrown). If the timeout fires
 * first, a `TimeoutError` is thrown.
 *
 * The timer is always cleaned up to avoid leaking handles, regardless
 * of which branch wins the race.
 *
 * @param promise - The async operation to time-bound
 * @param ms      - Timeout duration in milliseconds
 * @param label   - Optional label included in the `TimeoutError` message
 * @returns The resolved value of `promise`
 * @throws {TimeoutError} If the timeout fires before the promise settles
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label?: string,
): Promise<T> {
  const p = new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(ms, label));
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });

  // Attach a no-op handler so the rejection is never briefly "unhandled"
  // when the losing side of the race fires during fake-timer advancement.
  p.catch(() => {});

  return p;
}
