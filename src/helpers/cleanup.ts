/**
 * Process-level cleanup registry.
 *
 * Sub-modules (orchestrator, spec-generator) register their provider's
 * `cleanup()` here when the provider boots. The CLI signal handlers and
 * error handler drain the registry before exiting.
 *
 * All registered functions are invoked once; the registry is cleared
 * after each drain so repeated calls are harmless.
 */

const cleanups: Array<() => Promise<void>> = [];

/**
 * Register an async cleanup function to be called on process shutdown.
 */
export function registerCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

/**
 * Run all registered cleanup functions, then clear the registry.
 * Errors are swallowed to prevent cleanup failures from masking the
 * original error or blocking process exit.
 */
export async function runCleanup(): Promise<void> {
  const fns = cleanups.splice(0);
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      // swallow — cleanup must not throw
    }
  }
}
