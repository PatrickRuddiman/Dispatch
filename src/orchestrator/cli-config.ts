/**
 * CLI config resolution — loads the config file, merges config defaults
 * beneath CLI flags, validates mandatory configuration, and enables
 * verbose logging.
 *
 * Extracted from the orchestrator's `runFromCli()` method to keep the
 * coordinator thin and this logic independently testable.
 */

import { log } from "../helpers/logger.js";
import { loadConfig, type DispatchConfig } from "../config.js";
import type { RawCliArgs } from "./runner.js";

/**
 * Config key → RawCliArgs field mapping.
 *
 * Maps persistent config keys (from `~/.dispatch/config.json`) to their
 * corresponding field names on `RawCliArgs`. Used during the merge step
 * to fill in CLI flag defaults from the config file.
 */
const CONFIG_TO_CLI: Record<string, keyof RawCliArgs> = {
  provider: "provider",
  concurrency: "concurrency",
  source: "issueSource",
  org: "org",
  project: "project",
  serverUrl: "serverUrl",
  planTimeout: "planTimeout",
  planRetries: "planRetries",
};

/**
 * Resolve raw CLI arguments into a fully-merged and validated options
 * object, ready for pipeline delegation.
 *
 * 1. Loads the persistent config file (`~/.dispatch/config.json`)
 * 2. Merges config defaults beneath CLI flags (CLI wins when explicit)
 * 3. Validates that mandatory configuration (provider + source) is present
 *    — calls `process.exit(1)` on validation failure, matching current behavior
 * 4. Enables verbose logging if requested
 *
 * @param args - Raw CLI arguments as parsed by the CLI entry point
 * @returns The merged `RawCliArgs` with config defaults applied
 */
export async function resolveCliConfig(args: RawCliArgs): Promise<RawCliArgs> {
  const { explicitFlags } = args;

  // ── Load and merge config-file defaults beneath CLI flags ───
  const config = await loadConfig();

  const merged = { ...args };
  for (const [configKey, cliField] of Object.entries(CONFIG_TO_CLI)) {
    const configValue = config[configKey as keyof DispatchConfig];
    if (configValue !== undefined && !explicitFlags.has(cliField)) {
      (merged as unknown as Record<string, unknown>)[cliField] = configValue;
    }
  }

  // ── Mandatory config validation ────────────────────────────
  const providerConfigured =
    explicitFlags.has("provider") || config.provider !== undefined;
  const sourceConfigured =
    explicitFlags.has("issueSource") || config.source !== undefined;

  // fix-tests mode does not require a datasource
  const needsSource = !merged.fixTests;

  if (!providerConfigured || (needsSource && !sourceConfigured)) {
    const missing: string[] = [];
    if (!providerConfigured) missing.push("provider");
    if (needsSource && !sourceConfigured) missing.push("source");

    log.error(
      `Missing required configuration: ${missing.join(", ")}`
    );
    log.dim("  Configure defaults with:");
    if (!providerConfigured) {
      log.dim("    dispatch config set provider <name>");
    }
    if (needsSource && !sourceConfigured) {
      log.dim("    dispatch config set source <name>");
    }
    log.dim("  Or pass them as CLI flags: --provider <name> --source <name>");
    process.exit(1);
  }

  // ── Enable verbose logging ─────────────────────────────────
  log.verbose = merged.verbose;

  return merged;
}
