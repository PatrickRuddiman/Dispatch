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
  } catch (err: unknown) {
    // "code" in err is a runtime guard that proves the property exists
    if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      // File doesn't exist — will be created below
    } else {
      log.warn(`Could not read .gitignore: ${String(err)}`);
      return;
    }
  }

  const lines = contents.split(/\r?\n/);
  // Match with or without trailing slash to avoid adding a duplicate when
  // the user already has the bare form (e.g. `.dispatch/worktrees`) or the
  // slash form (e.g. `.dispatch/worktrees/`).
  const bare = entry.replace(/\/$/, "");
  const withSlash = bare + "/";
  if (lines.includes(entry) || lines.includes(bare) || lines.includes(withSlash)) {
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
