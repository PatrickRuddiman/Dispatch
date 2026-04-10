/**
 * CLI config resolution — loads the config file, merges config defaults
 * beneath CLI flags, validates mandatory configuration, and enables
 * verbose logging.
 *
 * Extracted from the orchestrator's `runFromCli()` method to keep the
 * coordinator thin and this logic independently testable.
 */

import { join } from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { log } from "../helpers/logger.js";
import { loadConfig, CONFIG_KEYS, type DispatchConfig, type ConfigKey } from "../config.js";
import type { RawCliArgs } from "./runner.js";
import { detectDatasource, DATASOURCE_NAMES } from "../datasources/index.js";

/**
 * Config key → RawCliArgs field mapping.
 *
 * Maps persistent config keys (from `{cwd}/.dispatch/config.json`) to their
 * corresponding field names on `RawCliArgs`. Used during the merge step
 * to fill in CLI flag defaults from the config file.
 */
const CONFIG_TO_CLI: Record<ConfigKey, keyof RawCliArgs> = {
  enabledProviders: "enabledProviders",
  providerModels: "providerModels",
  source: "issueSource",
  planTimeout: "planTimeout",
  specTimeout: "specTimeout",
  specWarnTimeout: "specWarnTimeout",
  specKillTimeout: "specKillTimeout",
  concurrency: "concurrency",
  org: "org",
  project: "project",
  workItemType: "workItemType",
  iteration: "iteration",
  area: "area",
  username: "username",
};

/** Type-safe indexed write into a RawCliArgs object. */
function setCliField<K extends keyof RawCliArgs>(
  target: RawCliArgs,
  key: K,
  value: RawCliArgs[K],
): void {
  target[key] = value;
}

/**
 * Resolve raw CLI arguments into a fully-merged and validated options
 * object, ready for pipeline delegation.
 *
 * 1. Loads the persistent config file (`{cwd}/.dispatch/config.json`)
 * 2. Merges config defaults beneath CLI flags (CLI wins when explicit)
 * 3. Validates that providers are available (via enabledProviders or --provider)
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
  for (const configKey of CONFIG_KEYS) {
    const cliField = CONFIG_TO_CLI[configKey];
    const configValue = config[configKey];
    if (configValue !== undefined && !explicitFlags.has(cliField)) {
      setCliField(merged, cliField, configValue);
    }
  }

  // ── Provider validation ───────────────────────────────────
  // Either --provider CLI flag or enabledProviders from config must be present.
  // The router will auto-detect authenticated providers as a fallback.
  const hasProvider = explicitFlags.has("provider") && merged.provider;
  const hasEnabledProviders = merged.enabledProviders && merged.enabledProviders.length > 0;

  if (!hasProvider && !hasEnabledProviders) {
    log.warn("No providers configured. The router will attempt to auto-detect authenticated providers.");
    log.dim("  Run 'dispatch config' to set up providers, or pass --provider <name>.");
  }

  // ── Output-dir validation ─────────────────────────────────
  if (merged.outputDir) {
    try {
      await access(merged.outputDir, constants.W_OK);
    } catch {
      log.error(
        `--output-dir path does not exist or is not writable: ${merged.outputDir}`,
      );
      process.exit(1);
    }
  }

  // ── Auto-detect datasource when not explicitly set ─────────
  const sourceConfigured =
    explicitFlags.has("issueSource") || config.source !== undefined;
  const needsSource = !merged.spec && !merged.respec;

  if (needsSource && !sourceConfigured) {
    const detected = await detectDatasource(merged.cwd);
    if (detected) {
      log.info(`Auto-detected datasource from git remote: ${detected}`);
      merged.issueSource = detected;
    } else {
      log.error("Datasource auto-detection failed — could not determine issue source from git remote.");
      log.dim(`  Available datasources: ${DATASOURCE_NAMES.join(", ")}`);
      log.dim("  Run 'dispatch config' to configure defaults interactively.");
      log.dim("  Or pass it as a CLI flag: --source <name>");
      process.exit(1);
    }
  }

  // ── Enable verbose logging ─────────────────────────────────
  log.verbose = merged.verbose;

  return merged;
}
