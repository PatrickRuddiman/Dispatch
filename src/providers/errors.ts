/**
 * Provider error classification utilities.
 *
 * Provides heuristic-based detection of throttle/rate-limit errors from
 * provider SDKs. All four providers surface errors as `throw new Error(msg)`
 * with messages containing HTTP status codes or human-readable throttle language.
 */

/**
 * Detect whether an error indicates throttling or rate-limiting by the provider.
 *
 * Uses pattern matching on error messages since provider SDKs don't expose
 * structured error codes. Covers common patterns across OpenAI-style APIs (429),
 * Copilot SDK error events, Claude API errors, and generic service unavailability.
 *
 * False positive = unnecessary failover (costs a retry, not data loss).
 * False negative = existing `withRetry` handles it (3 retries on any error).
 */
export function isThrottleError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /rate.limit|429|503|throttl|capacity|overloaded|too many requests|service unavailable/.test(msg);
}
