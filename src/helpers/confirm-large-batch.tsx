/**
 * Large-batch confirmation prompt.
 *
 * Asks the user to explicitly type "yes" before proceeding when a
 * spec or respec operation targets more items than the safety threshold.
 * Extracted into its own module so both the runner and spec-pipeline
 * call sites can share the logic and tests can mock it via `vi.mock()`.
 */

import { input } from "./ink-prompts.js";
import { log } from "./logger.js";

/** Default threshold above which confirmation is required. */
export const LARGE_BATCH_THRESHOLD = 100;

/**
 * Prompt the user to confirm a large batch operation.
 *
 * If `count` is at or below `threshold`, returns `true` immediately.
 * Otherwise, warns the user and requires them to type "yes" to proceed.
 *
 * @param count     - Number of specs that will be processed
 * @param threshold - Minimum count that triggers the prompt (default {@link LARGE_BATCH_THRESHOLD})
 * @returns `true` if the user confirmed (or count ≤ threshold), `false` otherwise
 */
export async function confirmLargeBatch(
  count: number,
  threshold: number = LARGE_BATCH_THRESHOLD,
): Promise<boolean> {
  if (count <= threshold) return true;

  log.warn(
    `This operation will process ${count} specs, which exceeds the safety threshold of ${threshold}.`,
  );

  const answer = await input({
    message: 'Type "yes" to proceed:',
  });

  return answer.trim().toLowerCase() === "yes";
}
