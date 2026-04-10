/**
 * Git worktree lifecycle manager.
 *
 * Creates, removes, and lists git worktrees in `.dispatch/worktrees/`.
 * Worktree directory names are derived from the leading numeric ID of the
 * issue filename (e.g., `123-fix-auth-bug.md` → `issue-123`).
 */

import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { slugify } from "./slugify.js";
import { log } from "./logger.js";

const exec = promisify(execFile);

/** Base directory for worktrees, relative to the repository root. */
const WORKTREE_DIR = ".dispatch/worktrees";

/** Execute a git command in the given working directory and return stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, shell: process.platform === "win32" });
  return stdout;
}

/**
 * Derive a worktree directory name from an issue filename.
 *
 * Extracts the leading numeric ID and returns `issue-{id}`.
 * Example: `123-fix-auth-bug.md` → `issue-123`
 *
 * @param issueFilename - The issue filename (basename or full path)
 * @returns A directory name suitable for a worktree
 */
export function worktreeName(issueFilename: string): string {
  const base = basename(issueFilename);
  const withoutExt = base.replace(/\.md$/i, "");
  const match = withoutExt.match(/^(\d+)/);
  return match ? `issue-${match[1]}` : slugify(withoutExt);
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
  startPoint?: string,
): Promise<string> {
  const name = worktreeName(issueFilename);
  const worktreePath = join(repoRoot, WORKTREE_DIR, name);

  if (existsSync(worktreePath)) {
    try {
      const listOutput = await git(["worktree", "list", "--porcelain"], repoRoot);
      const isRegistered = listOutput.includes(`worktree ${worktreePath}\n`);
      if (isRegistered) {
        // Reset to clean state
        try {
          await git(["checkout", "--force", branchName], worktreePath);
          await git(["clean", "-fd"], worktreePath);
          log.debug(`Reusing validated worktree at ${worktreePath}`);
          return worktreePath;
        } catch {
          // Checkout failed (wrong branch, etc.) — remove and recreate
          log.debug(`Worktree checkout failed, removing and recreating: ${worktreePath}`);
        }
      } else {
        log.debug(`Directory exists but not a registered worktree: ${worktreePath}`);
      }
    } catch {
      log.debug(`Worktree validation failed for ${worktreePath}`);
    }
    // Remove stale directory and fall through to creation
    await rm(worktreePath, { recursive: true, force: true });
    // Also prune to clean up any stale git refs
    await git(["worktree", "prune"], repoRoot).catch(() => {});
  }

  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 200;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const args = ["worktree", "add", worktreePath, "-b", branchName];
      if (startPoint) args.push(startPoint);
      await git(args, repoRoot);
      log.debug(`Created worktree at ${worktreePath} on branch ${branchName}`);
      return worktreePath;
    } catch (err) {
      lastError = err;
      const message = log.extractMessage(err);

      // Handle "branch already exists" — retry without -b
      if (message.includes("already exists")) {
        try {
          await git(["worktree", "add", worktreePath, branchName], repoRoot);
          log.debug(`Created worktree at ${worktreePath} using existing branch ${branchName}`);
          return worktreePath;
        } catch (retryErr) {
          lastError = retryErr;
          const retryMsg = log.extractMessage(retryErr);
          if (retryMsg.includes("already used by worktree")) {
            await git(["worktree", "prune"], repoRoot);
            try {
              await git(["worktree", "add", worktreePath, branchName], repoRoot);
              log.debug(`Created worktree at ${worktreePath} after pruning stale ref`);
              return worktreePath;
            } catch (pruneRetryErr) {
              lastError = pruneRetryErr;
            }
          } else {
            throw retryErr;
          }
        }
      } else if (message.includes("already used by worktree")) {
        await git(["worktree", "prune"], repoRoot);
        try {
          await git(["worktree", "add", worktreePath, branchName], repoRoot);
          log.debug(`Created worktree at ${worktreePath} after pruning stale ref`);
          return worktreePath;
        } catch (pruneRetryErr) {
          lastError = pruneRetryErr;
        }
      } else if (!message.includes("lock") && !message.includes("already")) {
        // Non-retryable error — throw immediately
        throw err;
      }

      // Retryable error (lock contention, race condition) — backoff and retry
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log.debug(`Worktree creation attempt ${attempt}/${MAX_RETRIES} failed (${message}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
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

/**
 * Generate a unique feature branch name.
 *
 * Produces a name in the format `dispatch/feature-{octet}`, where `{octet}`
 * is the first 8 hex characters of a random UUID.
 *
 * @returns A feature branch name like `dispatch/feature-a1b2c3d4`
 */
export function generateFeatureBranchName(): string {
  const uuid = randomUUID();
  const octet = uuid.split("-")[0];
  return `dispatch/feature-${octet}`;
}
