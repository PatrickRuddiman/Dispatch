/**
 * Utility for ensuring entries exist in a repository's .gitignore file.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";

/**
 * Ensure `entry` appears as a line in `<repoRoot>/.gitignore`.
 *
 * Creates the file if it doesn't exist. No-ops if the entry (with or without
 * a trailing slash) is already present. Logs a warning and continues on
 * failure — this is non-fatal so a permissions issue won't abort the run.
 *
 * @param repoRoot - Absolute path to the repository root
 * @param entry    - The gitignore pattern to add (e.g. `.dispatch/worktrees/`)
 */
export async function ensureGitignoreEntry(repoRoot: string, entry: string): Promise<void> {
  const gitignorePath = join(repoRoot, ".gitignore");

  let contents = "";
  try {
    contents = await readFile(gitignorePath, "utf8");
  } catch {
    // File doesn't exist — will be created below
  }

  const lines = contents.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  // Match with or without trailing slash to avoid adding a duplicate when
  // the user already has the bare form (e.g. `.dispatch/worktrees`).
  const bare = entry.replace(/\/$/, "");
  if (lines.includes(entry) || lines.includes(bare)) {
    return;
  }

  try {
    const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${contents}${separator}${entry}\n`, "utf8");
    log.debug(`Added '${entry}' to .gitignore`);
  } catch (err) {
    log.warn(`Could not update .gitignore: ${String(err)}`);
  }
}
