/**
 * Shared slug generation utility.
 *
 * Converts an arbitrary string into a URL/filename-safe slug by lowercasing,
 * replacing non-alphanumeric runs with hyphens, stripping leading/trailing
 * hyphens, and optionally truncating to a maximum length.
 *
 * Consolidates the identical slugification pattern previously duplicated
 * across datasource and orchestrator modules.
 */

/**
 * Convert a string into a lowercase, hyphen-separated slug.
 *
 * Applies the following transformations in order:
 * 1. Lowercase the entire string
 * 2. Replace runs of non-alphanumeric characters with a single hyphen
 * 3. Strip leading and trailing hyphens
 * 4. Truncate to `maxLength` characters (if provided)
 *
 * @param input     - The string to slugify
 * @param maxLength - Optional maximum length of the resulting slug
 * @returns The slugified string
 */
export function slugify(input: string, maxLength?: number): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return maxLength != null ? slug.slice(0, maxLength) : slug;
}
