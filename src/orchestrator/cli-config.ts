/**
 * CLI config resolution — loads the config file, merges config defaults
 * beneath CLI flags, validates mandatory configuration, and enables
 * verbose logging.
 *
 * Extracted from the orchestrator's `runFromCli()` method to keep the
 * coordinator thin and this logic independently testable.
 */

import { join } from "node:path";
import { log } from "../helpers/logger.js";
import { loadConfig, type DispatchConfig } from "../config.js";
import type { RawCliArgs } from "./runner.js";
import { detectDatasource } from "../datasources/index.js";

/**
 * Config key → RawCliArgs field mapping.
 *
 * Maps persistent config keys (from `{cwd}/.dispatch/config.json`) to their
 * corresponding field names on `RawCliArgs`. Used during the merge step
 * to fill in CLI flag defaults from the config file.
 */
const CONFIG_TO_CLI: Record<string, keyof RawCliArgs> = {
  provider: "provider",
  model: "model",
  concurrency: "concurrency",
  source: "issueSource",
  org: "org",
  project: "project",
  workItemType: "workItemType",
  serverUrl: "serverUrl",
  planTimeout: "planTimeout",
  planRetries: "planRetries",
  testTimeout: "testTimeout",
};

/**
 * Resolve raw CLI arguments into a fully-merged and validated options
 * object, ready for pipeline delegation.
 *
 * 1. Loads the persistent config file (`{cwd}/.dispatch/config.json`)
 * 2. Merges config defaults beneath CLI flags (CLI wins when explicit)
 * 3. Validates that mandatory configuration (provider + source) is present
 *    — calls `process.exit(1)` on validation failure, matching current behavior
 * 4. Auto-detects the datasource from the git remote when not explicitly set
 *    — skipped for spec/respec modes, which defer source resolution to the
 *      pipeline's own `resolveSource()` (context-aware fallback logic)
 * 5. Enables verbose logging if requested
 *
 * @param args - Raw CLI arguments as parsed by the CLI entry point
 * @returns The merged `RawCliArgs` with config defaults applied
 */
export async function resolveCliConfig(args: RawCliArgs): Promise<RawCliArgs> {
  const { explicitFlags } = args;

  // ── Load and merge config-file defaults beneath CLI flags ───
  const configDir = join(args.cwd, ".dispatch");
  const config = await loadConfig(configDir);

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

  if (!providerConfigured) {
    log.error("Missing required configuration: provider");
    log.dim("  Run 'dispatch config' to configure defaults interactively.");
    log.dim("  Or pass it as a CLI flag: --provider <name>");
    process.exit(1);
  }

  // ── Auto-detect datasource when not explicitly set ─────────
  const sourceConfigured =
    explicitFlags.has("issueSource") || config.source !== undefined;
  const needsSource = !merged.fixTests && !merged.spec && !merged.respec;

  if (needsSource && !sourceConfigured) {
    const detected = await detectDatasource(merged.cwd);
    if (detected) {
      log.info(`Auto-detected datasource from git remote: ${detected}`);
      merged.issueSource = detected;
    } else {
      log.info("Could not detect datasource from git remote, falling back to: md");
      merged.issueSource = "md";
    }
  }

  // ── Enable verbose logging ─────────────────────────────────
  log.verbose = merged.verbose;

  return merged;
}
