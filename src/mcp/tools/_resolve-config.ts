/**
 * Shared config resolution for MCP tools.
 *
 * Loads `.dispatch/config.json` and returns the config. Throws if the
 * config file is missing or has no provider configured — MCP tools
 * require explicit configuration (unlike the CLI which has an
 * interactive wizard fallback).
 */

import { join } from "node:path";
import { loadConfig, type DispatchConfig } from "../../config.js";
import { detectDatasource } from "../../datasources/index.js";

/**
 * Load and validate the Dispatch config for MCP tool use.
 *
 * - Throws if no provider is configured (neither in config nor passed by caller).
 * - Auto-detects datasource from git remote when not configured.
 */
export async function loadMcpConfig(
  cwd: string,
  overrides?: { provider?: string; source?: string },
): Promise<DispatchConfig> {
  const config = await loadConfig(join(cwd, ".dispatch"));

  // Provider must be configured (config file or caller override)
  const provider = overrides?.provider ?? config.provider;
  if (!provider) {
    throw new Error(
      "Missing required configuration: provider. Run 'dispatch config' to set up defaults.",
    );
  }

  // Source: caller override > config > auto-detect from git remote
  let source = overrides?.source ?? config.source;
  if (!source) {
    const detected = await detectDatasource(cwd);
    if (detected) {
      source = detected;
    }
  }

  return { ...config, provider: provider as DispatchConfig["provider"], source: source as DispatchConfig["source"] };
}
