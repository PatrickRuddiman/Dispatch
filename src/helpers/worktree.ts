/**
 * Git worktree lifecycle manager.
 *
 * Creates, removes, and lists git worktrees in `.dispatch/worktrees/`.
 * Worktree directory names are derived from issue filenames using the
 * `slugify` utility (e.g., `123-fix-auth-bug.md` → `123-fix-auth-bug`).
 */

import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slugify } from "./slugify.js";
import { log } from "./logger.js";

const exec = promisify(execFile);

/** Base directory for worktrees, relative to the repository root. */
const WORKTREE_DIR = ".dispatch/worktrees";

/** Execute a git command in the given working directory and return stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

/**
 * Derive a worktree directory name from an issue filename.
 *
 * Strips the `.md` extension and slugifies the result.
 * Example: `123-fix-auth-bug.md` → `123-fix-auth-bug`
 *
 * @param issueFilename - The issue filename (basename or full path)
 * @returns A slugified directory name suitable for a worktree
 */
export function worktreeName(issueFilename: string): string {
  const base = basename(issueFilename);
  const withoutExt = base.replace(/\.md$/i, "");
  return slugify(withoutExt);
}

/**
 * Create a git worktree for the given issue file.
 *
 * The worktree is placed at `.dispatch/worktrees/<name>` (relative to `repoRoot`)
 * and checks out a new branch with the specified `branchName`.
 *
 * @param repoRoot     - Absolute path to the repository root
 * @param issueFilename - The issue filename used to derive the worktree directory name
 * @param branchName   - The branch name to create and check out in the worktree
 * @returns The absolute path to the created worktree directory
 */
export async function createWorktree(
  repoRoot: string,
  issueFilename: string,
  branchName: string,
): Promise<string> {
  const name = worktreeName(issueFilename);
  const worktreePath = join(repoRoot, WORKTREE_DIR, name);

  try {
    await git(["worktree", "add", worktreePath, "-b", branchName], repoRoot);
    log.debug(`Created worktree at ${worktreePath} on branch ${branchName}`);
  } catch (err) {
    const message = log.extractMessage(err);
    // If the branch already exists, try adding without -b
    if (message.includes("already exists")) {
      await git(["worktree", "add", worktreePath, branchName], repoRoot);
      log.debug(`Created worktree at ${worktreePath} using existing branch ${branchName}`);
    } else {
      throw err;
    }
  }

  return worktreePath;
}

/**
 * Remove a git worktree.
 *
 * Attempts a normal removal first, falling back to `--force` if needed.
 * Runs `git worktree prune` afterwards to clean up stale references.
 * Logs a warning instead of throwing on failure so execution can continue.
 *
 * @param repoRoot     - Absolute path to the repository root
 * @param issueFilename - The issue filename used to derive the worktree directory name
 */
export async function removeWorktree(
  repoRoot: string,
  issueFilename: string,
): Promise<void> {
  const name = worktreeName(issueFilename);
  const worktreePath = join(repoRoot, WORKTREE_DIR, name);

  try {
    await git(["worktree", "remove", worktreePath], repoRoot);
  } catch {
    // Force removal as fallback
    try {
      await git(["worktree", "remove", "--force", worktreePath], repoRoot);
    } catch (err) {
      log.warn(`Could not remove worktree ${name}: ${log.formatErrorChain(err)}`);
      return;
    }
  }

  // Prune stale worktree references
  try {
    await git(["worktree", "prune"], repoRoot);
  } catch (err) {
    log.warn(`Could not prune worktrees: ${log.formatErrorChain(err)}`);
  }
}

/**
 * List all current git worktrees in the repository.
 *
 * Returns the raw `git worktree list` output for diagnostic purposes.
 *
 * @param repoRoot - Absolute path to the repository root
 * @returns The worktree list output string
 */
export async function listWorktrees(repoRoot: string): Promise<string> {
  try {
    return await git(["worktree", "list"], repoRoot);
  } catch (err) {
    log.warn(`Could not list worktrees: ${log.formatErrorChain(err)}`);
    return "";
  }
}
