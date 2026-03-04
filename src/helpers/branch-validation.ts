/**
 * Shared branch-name validation utilities.
 *
 * Provides a strict validator (`isValidBranchName`) and a typed error class
 * (`InvalidBranchNameError`) that enforce git refname rules.  Extracted from
 * the GitHub datasource so every datasource can share the same logic.
 */

/**
 * Thrown when a branch name fails validation.
 * Provides reliable `instanceof` detection instead of brittle message-string checks.
 */
export class InvalidBranchNameError extends Error {
  constructor(branch: string, reason?: string) {
    const detail = reason ? ` (${reason})` : "";
    super(`Invalid branch name: "${branch}"${detail}`);
    this.name = "InvalidBranchNameError";
  }
}

/** Strict pattern for valid git branch name character set. */
export const VALID_BRANCH_NAME_RE = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Check whether a branch name is safe to use in git/gh commands.
 * Enforces git refname rules beyond simple character validation:
 *  - Must be 1–255 characters of allowed characters
 *  - Cannot start or end with "/"
 *  - Cannot contain ".." (parent traversal)
 *  - Cannot end with ".lock"
 *  - Cannot contain "@{" (reflog syntax)
 *  - Cannot contain "//" (empty path component)
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (!VALID_BRANCH_NAME_RE.test(name)) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.includes("..")) return false;
  if (name.endsWith(".lock")) return false;
  if (name.includes("@{")) return false;
  if (name.includes("//")) return false;
  return true;
}
