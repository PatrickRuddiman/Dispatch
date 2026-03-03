/**
 * Runtime type guard utilities.
 *
 * Provides small, reusable type predicates that validate unknown values
 * at runtime, enabling safe property access without unsafe `as` casts.
 */

/**
 * Check whether an unknown value is a non-null object that contains
 * the specified key.
 *
 * Narrows the value to `Record<K, unknown>` so the caller can safely
 * access `value[key]` without an `as` cast.
 *
 * @param value - The value to inspect (may be any type).
 * @param key   - The property name to look for.
 * @returns `true` when `value` is an object with the given key.
 */
export function hasProperty<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, unknown> {
  return typeof value === "object" && value !== null && key in value;
}
