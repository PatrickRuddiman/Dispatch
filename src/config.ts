/**
 * Configuration data layer for Dispatch.
 *
 * Manages persistent user configuration stored in ~/.dispatch/config.json.
 * Provides functions for loading, saving, and validating config values.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { PROVIDER_NAMES } from "./providers/index.js";
import { ISSUE_SOURCE_NAMES } from "./issue-fetchers/index.js";
import type { ProviderName } from "./provider.js";
import type { IssueSourceName } from "./issue-fetcher.js";

/**
 * Persistent configuration options for Dispatch.
 * All fields are optional since the config file may contain any subset.
 */
export interface DispatchConfig {
  provider?: ProviderName;
  concurrency?: number;
  source?: IssueSourceName;
  org?: string;
  project?: string;
  serverUrl?: string;
}

/** Valid configuration key names. */
export const CONFIG_KEYS = [
  "provider",
  "concurrency",
  "source",
  "org",
  "project",
  "serverUrl",
] as const;

/** A valid configuration key name. */
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Get the path to the config file.
 * Accepts an optional `configDir` override for testing.
 */
export function getConfigPath(configDir?: string): string {
  const dir = configDir ?? join(homedir(), ".dispatch");
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
 * Check whether a string is a valid config key.
 */
export function isValidConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
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
      if (!ISSUE_SOURCE_NAMES.includes(value as IssueSourceName)) {
        return `Invalid source "${value}". Available: ${ISSUE_SOURCE_NAMES.join(", ")}`;
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
    case "serverUrl":
      if (!value || value.trim() === "") {
        return `Invalid ${key}: value must not be empty`;
      }
      return null;

    default:
      return `Unknown config key "${key}"`;
  }
}

/**
 * Parse a string value into the appropriate type for a config key.
 */
export function parseConfigValue(key: ConfigKey, value: string): string | number {
  if (key === "concurrency") {
    return parseInt(value, 10);
  }
  return value;
}
