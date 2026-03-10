/**
 * Startup prerequisite checker.
 *
 * Verifies that required external tools and runtime versions are available
 * before any pipeline logic runs. Returns an array of human-readable failure
 * messages — an empty array means all checks pass.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Minimum supported Node.js version (matches package.json engines field). */
const MIN_NODE_VERSION = "20.12.0";

/**
 * Parse a semver-style version string into [major, minor, patch] numbers.
 */
function parseSemver(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".").map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

/**
 * Return true if `current` is greater than or equal to `minimum`
 * using major.minor.patch comparison.
 */
function semverGte(current: string, minimum: string): boolean {
  const [cMaj, cMin, cPat] = parseSemver(current);
  const [mMaj, mMin, mPat] = parseSemver(minimum);
  if (cMaj !== mMaj) return cMaj > mMaj;
  if (cMin !== mMin) return cMin > mMin;
  return cPat >= mPat;
}

/**
 * Verify that required external tools and runtime versions are available.
 *
 * Checks performed:
 * 1. `git` is available on PATH (via `git --version`)
 * 2. Node.js version meets the `>=20.12.0` minimum
 *
 * @returns An array of human-readable failure message strings.
 *          An empty array means all checks passed.
 */
export async function checkPrereqs(): Promise<string[]> {
  const failures: string[] = [];

  // Check git availability
  try {
    await exec("git", ["--version"], { shell: process.platform === "win32" });
  } catch {
    failures.push("git is required but was not found on PATH. Install it from https://git-scm.com");
  }

  // Check Node.js version
  const nodeVersion = process.versions.node;
  if (!semverGte(nodeVersion, MIN_NODE_VERSION)) {
    failures.push(
      `Node.js >= ${MIN_NODE_VERSION} is required but found ${nodeVersion}. Please upgrade Node.js`,
    );
  }

  return failures;
}
