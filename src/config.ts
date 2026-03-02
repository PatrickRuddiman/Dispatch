/**
 * Configuration data layer for Dispatch.
 *
 * Manages persistent user configuration stored in ~/.dispatch/config.json.
 * Provides functions for loading, saving, and validating config values.
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { PROVIDER_NAMES } from "./providers/index.js";
import { DATASOURCE_NAMES } from "./datasources/index.js";
import type { ProviderName } from "./providers/interface.js";
import type { DatasourceName } from "./datasources/interface.js";
import { log } from "./helpers/logger.js";
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
 * Parse a string value into the appropriate type for a config key.
 */
export function parseConfigValue(key: ConfigKey, value: string): string | number {
  if (key === "concurrency" || key === "planRetries") {
    return parseInt(value, 10);
  }
  if (key === "planTimeout") {
    return parseFloat(value);
  }
  return value;
}

/**
 * Handle the `dispatch config` subcommand.
 *
 * Supports: set, get, list, reset, path.
 * Uses `log` for error/success output and plain `console.log` for
 * pipe-friendly output (get, list, path).
 */
export async function handleConfigCommand(argv: string[]): Promise<void> {
  const [operation, ...rest] = argv;

  switch (operation) {
    case "set": {
      const [key, value] = rest;
      if (!key || value === undefined) {
        log.error("Usage: dispatch config set <key> <value>");
        log.dim(`  Valid keys: ${CONFIG_KEYS.join(", ")}`);
        process.exit(1);
      }
      if (!isValidConfigKey(key)) {
        log.error(`Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}`);
        process.exit(1);
      }
      const error = validateConfigValue(key, value);
      if (error) {
        log.error(error);
        process.exit(1);
      }
      const config = await loadConfig();
      const parsed = parseConfigValue(key, value);
      (config as Record<string, string | number>)[key] = parsed;
      await saveConfig(config);
      log.success(`Set ${key} = ${value}`);
      break;
    }

    case "get": {
      const [key] = rest;
      if (!key) {
        log.error("Usage: dispatch config get <key>");
        process.exit(1);
      }
      if (!isValidConfigKey(key)) {
        log.error(`Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}`);
        process.exit(1);
      }
      const config = await loadConfig();
      const value = config[key];
      if (value !== undefined) {
        console.log(value);
      }
      break;
    }

    case "list": {
      const config = await loadConfig();
      const entries = Object.entries(config).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        log.dim("No configuration set.");
      } else {
        for (const [k, v] of entries) {
          console.log(`${k}=${v}`);
        }
      }
      break;
    }

    case "reset": {
      const configPath = getConfigPath();
      try {
        await rm(configPath, { force: true });
        log.success("Configuration reset.");
      } catch {
        log.success("Configuration reset.");
      }
      break;
    }

    case "path": {
      console.log(getConfigPath());
      break;
    }

    default: {
      if (operation) {
        log.error(`Unknown config operation "${operation}".`);
        log.dim("  Usage: dispatch config <set|get|list|reset|path>");
        log.dim("  Example: dispatch config set provider copilot");
        log.dim("  Example: dispatch config get provider");
        log.dim("  Example: dispatch config list");
        process.exit(1);
      } else {
        await runInteractiveConfigWizard();
      }
      break;
    }
  }
}
