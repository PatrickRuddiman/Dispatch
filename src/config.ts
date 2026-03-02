/**
 * Configuration data layer for Dispatch.
 *
 * Manages persistent user configuration stored in {CWD}/.dispatch/config.json.
 * Provides functions for loading, saving, and validating config values.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { PROVIDER_NAMES } from "./providers/index.js";
import { DATASOURCE_NAMES } from "./datasources/index.js";
import type { ProviderName } from "./providers/interface.js";
import type { DatasourceName } from "./datasources/interface.js";
import { runInteractiveConfigWizard } from "./config-prompts.js";

/**
 * Persistent configuration options for Dispatch.
 * All fields are optional since the config file may contain any subset.
 */
export interface DispatchConfig {
  provider?: ProviderName;
  concurrency?: number;
  source?: DatasourceName;
  org?: string;
  project?: string;
  workItemType?: string;
  serverUrl?: string;
  planTimeout?: number;
  planRetries?: number;
}

/** Valid configuration key names. */
export const CONFIG_KEYS = [
  "provider",
  "concurrency",
  "source",
  "org",
  "project",
  "workItemType",
  "serverUrl",
  "planTimeout",
  "planRetries",
] as const;

/** A valid configuration key name. */
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Get the path to the config file.
 * Accepts an optional `configDir` override for testing.
 */
export function getConfigPath(configDir?: string): string {
  const dir = configDir ?? join(process.cwd(), ".dispatch");
  return join(dir, "config.json");
}

/**
 * Load the config from disk.
 * Returns `{}` if the file doesn't exist or contains invalid JSON.
 * Accepts an optional `configDir` override for testing.
 */
export async function loadConfig(configDir?: string): Promise<DispatchConfig> {
  const configPath = getConfigPath(configDir);
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as DispatchConfig;
  } catch {
    return {};
  }
}

/**
 * Save the config to disk as pretty-printed JSON.
 * Creates the parent directory if it doesn't exist.
 * Accepts an optional `configDir` override for testing.
 */
export async function saveConfig(
  config: DispatchConfig,
  configDir?: string,
): Promise<void> {
  const configPath = getConfigPath(configDir);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Validate a value for a given config key.
 * Returns `null` if valid, or an error message string if invalid.
 */
export function validateConfigValue(key: ConfigKey, value: string): string | null {
  switch (key) {
    case "provider":
      if (!PROVIDER_NAMES.includes(value as ProviderName)) {
        return `Invalid provider "${value}". Available: ${PROVIDER_NAMES.join(", ")}`;
      }
      return null;

    case "source":
      if (!DATASOURCE_NAMES.includes(value as DatasourceName)) {
        return `Invalid source "${value}". Available: ${DATASOURCE_NAMES.join(", ")}`;
      }
      return null;

    case "concurrency": {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1) {
        return `Invalid concurrency "${value}". Must be a positive integer`;
      }
      return null;
    }

    case "org":
    case "project":
    case "workItemType":
    case "serverUrl":
      if (!value || value.trim() === "") {
        return `Invalid ${key}: value must not be empty`;
      }
      return null;

    case "planTimeout": {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        return `Invalid planTimeout "${value}". Must be a positive number (minutes)`;
      }
      return null;
    }

    case "planRetries": {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        return `Invalid planRetries "${value}". Must be a non-negative integer`;
      }
      return null;
    }

    default:
      return `Unknown config key "${key}"`;
  }
}

/**
 * Handle the `dispatch config` subcommand.
 *
 * Launches the interactive configuration wizard.
 */
export async function handleConfigCommand(_argv: string[], configDir?: string): Promise<void> {
  await runInteractiveConfigWizard(configDir);
}
