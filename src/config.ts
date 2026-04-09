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
  /**
   * Providers the user has authenticated and enabled.
   * Populated by the config wizard during auth setup.
   * The router uses this list to decide which providers to route to.
   */
  enabledProviders?: ProviderName[];
  source?: DatasourceName;
  planTimeout?: number;
  specTimeout?: number;
  specWarnTimeout?: number;
  specKillTimeout?: number;
  concurrency?: number;
  org?: string;
  project?: string;
  workItemType?: string;
  iteration?: string;
  area?: string;
  /** Short username prefix for branch names (e.g. "pr" instead of "patrick-ruddiman"). */
  username?: string;
  /** Internal auto-increment counter for MD datasource issue IDs. Defaults to 1 when absent. */
  nextIssueId?: number;
}

/** Minimum and maximum bounds for numeric configuration values. */
export const CONFIG_BOUNDS = {
  planTimeout: { min: 1, max: 120 },
  specTimeout: { min: 1, max: 120 },
  specWarnTimeout: { min: 1, max: 120 },
  specKillTimeout: { min: 1, max: 120 },
  concurrency: { min: 1, max: 64 },
} as const;

/** Valid configuration key names. */
export const CONFIG_KEYS = ["enabledProviders", "source", "planTimeout", "specTimeout", "specWarnTimeout", "specKillTimeout", "concurrency", "org", "project", "workItemType", "iteration", "area", "username"] as const;

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
 * Migrates legacy configs that used `provider`/`model`/`agents` fields.
 * Accepts an optional `configDir` override for testing.
 */
export async function loadConfig(configDir?: string): Promise<DispatchConfig> {
  const configPath = getConfigPath(configDir);
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return migrateConfig(parsed);
  } catch {
    return {};
  }
}

/**
 * Migrate legacy config format to the new schema.
 *
 * Old configs had: provider, model, fastProvider, fastModel, agents
 * New configs have: enabledProviders
 *
 * Legacy fields are silently dropped. The provider name is extracted
 * into enabledProviders if not already set.
 */
function migrateConfig(raw: Record<string, unknown>): DispatchConfig {
  const config: DispatchConfig = {};

  // Migrate legacy provider field into enabledProviders
  if (!raw.enabledProviders && raw.provider) {
    const providers = new Set<ProviderName>();
    const legacyProvider = raw.provider as ProviderName;
    if (PROVIDER_NAMES.includes(legacyProvider)) {
      providers.add(legacyProvider);
    }
    // Also pick up fastProvider if different
    if (raw.fastProvider) {
      const fastProvider = raw.fastProvider as ProviderName;
      if (PROVIDER_NAMES.includes(fastProvider)) {
        providers.add(fastProvider);
      }
    }
    // Pick up per-agent providers
    if (raw.agents && typeof raw.agents === "object") {
      for (const agentCfg of Object.values(raw.agents as Record<string, { provider?: string }>)) {
        if (agentCfg?.provider && PROVIDER_NAMES.includes(agentCfg.provider as ProviderName)) {
          providers.add(agentCfg.provider as ProviderName);
        }
      }
    }
    if (providers.size > 0) {
      config.enabledProviders = [...providers];
    }
  } else if (Array.isArray(raw.enabledProviders)) {
    config.enabledProviders = (raw.enabledProviders as string[]).filter((p) =>
      PROVIDER_NAMES.includes(p as ProviderName),
    ) as ProviderName[];
  }

  // Copy over non-legacy fields
  if (raw.source !== undefined) config.source = raw.source as DatasourceName;
  if (raw.planTimeout !== undefined) config.planTimeout = raw.planTimeout as number;
  if (raw.specTimeout !== undefined) config.specTimeout = raw.specTimeout as number;
  if (raw.specWarnTimeout !== undefined) config.specWarnTimeout = raw.specWarnTimeout as number;
  if (raw.specKillTimeout !== undefined) config.specKillTimeout = raw.specKillTimeout as number;
  if (raw.concurrency !== undefined) config.concurrency = raw.concurrency as number;
  if (raw.org !== undefined) config.org = raw.org as string;
  if (raw.project !== undefined) config.project = raw.project as string;
  if (raw.workItemType !== undefined) config.workItemType = raw.workItemType as string;
  if (raw.iteration !== undefined) config.iteration = raw.iteration as string;
  if (raw.area !== undefined) config.area = raw.area as string;
  if (raw.username !== undefined) config.username = raw.username as string;
  if (raw.nextIssueId !== undefined) config.nextIssueId = raw.nextIssueId as number;

  return config;
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
    case "enabledProviders":
      // Array field — skip string-level validation.
      return null;

    case "source":
      if (!DATASOURCE_NAMES.includes(value as DatasourceName)) {
        return `Invalid source "${value}". Available: ${DATASOURCE_NAMES.join(", ")}`;
      }
      return null;

    case "planTimeout": {
      const num = Number(value);
      if (!Number.isFinite(num) || num < CONFIG_BOUNDS.planTimeout.min || num > CONFIG_BOUNDS.planTimeout.max) {
        return `Invalid planTimeout "${value}". Must be a number between ${CONFIG_BOUNDS.planTimeout.min} and ${CONFIG_BOUNDS.planTimeout.max} (minutes)`;
      }
      return null;
    }

    case "specTimeout": {
      const num = Number(value);
      if (!Number.isFinite(num) || num < CONFIG_BOUNDS.specTimeout.min || num > CONFIG_BOUNDS.specTimeout.max) {
        return `Invalid specTimeout "${value}". Must be a number between ${CONFIG_BOUNDS.specTimeout.min} and ${CONFIG_BOUNDS.specTimeout.max} (minutes)`;
      }
      return null;
    }

    case "specWarnTimeout": {
      const num = Number(value);
      if (!Number.isFinite(num) || num < CONFIG_BOUNDS.specWarnTimeout.min || num > CONFIG_BOUNDS.specWarnTimeout.max) {
        return `Invalid specWarnTimeout "${value}". Must be a number between ${CONFIG_BOUNDS.specWarnTimeout.min} and ${CONFIG_BOUNDS.specWarnTimeout.max} (minutes)`;
      }
      return null;
    }

    case "specKillTimeout": {
      const num = Number(value);
      if (!Number.isFinite(num) || num < CONFIG_BOUNDS.specKillTimeout.min || num > CONFIG_BOUNDS.specKillTimeout.max) {
        return `Invalid specKillTimeout "${value}". Must be a number between ${CONFIG_BOUNDS.specKillTimeout.min} and ${CONFIG_BOUNDS.specKillTimeout.max} (minutes)`;
      }
      return null;
    }

    case "concurrency": {
      const num = Number(value);
      if (!Number.isInteger(num) || num < CONFIG_BOUNDS.concurrency.min || num > CONFIG_BOUNDS.concurrency.max) {
        return `Invalid concurrency "${value}". Must be an integer between ${CONFIG_BOUNDS.concurrency.min} and ${CONFIG_BOUNDS.concurrency.max}`;
      }
      return null;
    }

    case "org":
    case "project":
    case "workItemType":
    case "iteration":
    case "area":
      if (!value || value.trim() === "") {
        return `Invalid ${key}: value must not be empty`;
      }
      return null;

    case "username": {
      if (!value || value.trim() === "") {
        return `Invalid username: value must not be empty`;
      }
      if (value.length > 20) {
        return `Invalid username "${value}". Must be at most 20 characters`;
      }
      if (!/^[a-zA-Z0-9-]+$/.test(value)) {
        return `Invalid username "${value}". Must contain only alphanumeric characters and hyphens`;
      }
      return null;
    }

    default: {
      const _exhaustive: never = key;
      return `Unknown config key "${_exhaustive}"`;
    }
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
