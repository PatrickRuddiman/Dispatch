/**
 * Install the Dispatch skill into ~/.agents/skills/ (universal) and
 * any provider-specific skill directories so all providers can use
 * /dispatch in the shell.
 *
 * Copies skill files from the package's skills/dispatch/ directory.
 * Removes copied files on cleanup (only if we created them).
 */

import { cp, rm, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderName } from "../providers/interface.js";
import { log } from "../helpers/logger.js";

/** Resolve the path to the Dispatch skill source directory in the package. */
function resolveSkillSource(): string {
  return join(import.meta.dirname, "..", "skills", "dispatch");
}

/** Get all directories the skill should be copied to. */
function getSkillDirs(provider: ProviderName): string[] {
  const home = homedir();
  const dirs = [
    // Universal agents skills directory
    join(home, ".agents", "skills"),
  ];

  // Provider-specific skill directories
  switch (provider) {
    case "claude":
      dirs.push(join(home, ".claude", "skills"));
      break;
    case "codex":
      dirs.push(join(home, ".codex", "skills"));
      break;
  }

  return dirs;
}

/**
 * Install the Dispatch skill for the given provider.
 * Returns a cleanup function that removes copied files.
 */
export async function installSkill(provider: ProviderName): Promise<() => Promise<void>> {
  const source = resolveSkillSource();

  try {
    await readdir(source);
  } catch {
    log.debug(`Skill source not found at ${source} — skipping install`);
    return async () => {};
  }

  const skillDirs = getSkillDirs(provider);
  const createdPaths: string[] = [];

  for (const skillDir of skillDirs) {
    const dest = join(skillDir, "dispatch");

    let alreadyExisted = false;
    try {
      await readdir(dest);
      alreadyExisted = true;
    } catch {
      // Doesn't exist yet
    }

    try {
      await mkdir(skillDir, { recursive: true });
      await cp(source, dest, { recursive: true, force: true });
      log.debug(`Installed dispatch skill at ${dest}`);
      if (!alreadyExisted) {
        createdPaths.push(dest);
      }
    } catch (err) {
      log.debug(`Failed to install skill at ${dest}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return async () => {
    for (const p of createdPaths) {
      try {
        await rm(p, { recursive: true });
        log.debug(`Removed dispatch skill at ${p}`);
      } catch { /* best effort */ }
    }
  };
}
