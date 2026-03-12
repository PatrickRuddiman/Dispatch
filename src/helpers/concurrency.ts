/**
 * Sliding-window concurrency utility.
 *
 * Provides a reusable `runWithConcurrency` function that processes a queue
 * of work items with a fixed concurrency limit. Unlike batch-then-await
 * (`Promise.all` on N items), this starts a new task as soon as any
 * running task completes, keeping the number of active tasks pinned to
 * `min(limit, remaining)` at all times.
 */

/** Options for {@link runWithConcurrency}. */
export interface ConcurrencyOptions<T, R> {
  /** Work items to process. */
  items: T[];
  /** Maximum number of concurrent workers. */
  concurrency: number;
  /** Async function invoked once per item. */
  worker: (item: T, index: number) => Promise<R>;
  /**
   * Optional signal that, when it returns `true`, prevents new items from
   * being launched. Already-running tasks are allowed to finish.
   */
  shouldStop?: () => boolean;
}

/** Result of a single work item. */
export type ConcurrencyResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown }
  | { status: "skipped" };

/**
 * Process `items` through `worker` with sliding-window concurrency.
 *
 * At most `concurrency` invocations of `worker` run simultaneously.
 * When any running worker settles, the next queued item is started
 * immediately, keeping utilisation at the concurrency limit until the
 * queue is drained.
 *
 * If `shouldStop` is provided and returns `true`, no new items are
 * launched, but already-running workers are awaited before returning.
 *
 * Returns an array of per-item results in the same order as `items`,
 * each wrapped in a `{ status, value/reason }` discriminated union
 * (similar to `Promise.allSettled`).
 *
 * @returns Per-item results in input order.
 */
export async function runWithConcurrency<T, R>(
  options: ConcurrencyOptions<T, R>,
): Promise<ConcurrencyResult<R>[]> {
  const { items, concurrency, worker, shouldStop } = options;

  if (items.length === 0) return [];

  const limit = Math.max(1, concurrency);
  const results: ConcurrencyResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  return new Promise<ConcurrencyResult<R>[]>((resolve) => {
    let active = 0;

    const launch = (): void => {
      while (active < limit && nextIndex < items.length) {
        if (shouldStop?.()) break;

        const idx = nextIndex++;
        active++;

        worker(items[idx], idx).then(
          (value) => {
            results[idx] = { status: "fulfilled", value };
            active--;
            launch();
          },
          (reason) => {
            results[idx] = { status: "rejected", reason };
            active--;
            launch();
          },
        );
      }

      if (active === 0) {
        // Fill slots for items that were never launched (due to shouldStop)
        for (let i = 0; i < results.length; i++) {
          if (!(i in results)) {
            results[i] = { status: "skipped" };
          }
        }
        resolve(results);
      }
    };

    launch();
  });
}
