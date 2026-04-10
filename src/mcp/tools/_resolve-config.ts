/**
 * Shared config resolution for MCP tools.
 *
 * Loads `.dispatch/config.json` and returns the config. Throws if no
 * providers are configured — MCP tools require explicit configuration
 * (unlike the CLI which can auto-detect authenticated providers).
 */

import { join } from "node:path";
import { loadConfig, type DispatchConfig } from "../../config.js";
import { detectDatasource } from "../../datasources/index.js";

/**
 * Load and validate the Dispatch config for MCP tool use.
 *
 * - Throws if no enabled providers are configured.
 * - Auto-detects datasource from git remote when not configured.
 */
export async function loadMcpConfig(
  cwd: string,
  overrides?: { provider?: string; source?: string },
): Promise<DispatchConfig> {
  const config = await loadConfig(join(cwd, ".dispatch"));

  // At least one provider must be configured (or passed by caller)
  const hasProviders = config.enabledProviders && config.enabledProviders.length > 0;
  if (!hasProviders && !overrides?.provider) {
    throw new Error(
      "Missing required configuration: no providers configured. Run 'dispatch config' to set up providers.",
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

  return { ...config, source: source as DispatchConfig["source"] };
}
