/**
 * Provider binary detection — checks whether each provider's CLI binary
 * is available on PATH.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProviderName } from "./interface.js";

const exec = promisify(execFile);

/**
 * Maps each provider name to its expected CLI binary.
 */
export const PROVIDER_BINARIES: Record<ProviderName, string> = {
  opencode: "opencode",
  copilot: "copilot",
  claude: "claude",
  codex: "codex",
};

/**
 * Check whether a provider's CLI binary is available on PATH.
 *
 * Attempts to execute the binary with `--version`. Resolves `true` if the
 * binary is found, `false` otherwise. Never rejects.
 */
export async function checkProviderInstalled(
  name: ProviderName,
): Promise<boolean> {
  try {
    await exec(PROVIDER_BINARIES[name], ["--version"]);
    return true;
  } catch {
    return false;
  }
}
