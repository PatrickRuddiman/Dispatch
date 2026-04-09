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
import type { AgentName } from "./agents/interface.js";
import { runInteractiveConfigWizard } from "./config-prompts.js";

/**
 * Per-agent provider/model override.
 * Missing fields inherit from the top-level `provider`/`model`.
 */
export interface AgentConfig {
  provider?: ProviderName;
  model?: string;
}

/**
 * Persistent configuration options for Dispatch.
 * All fields are optional since the config file may contain any subset.
 */
export interface DispatchConfig {
  provider?: ProviderName;
  /**
   * Model to use when spawning agents, in provider-specific format.
   *   - Copilot: bare model ID (e.g. "claude-sonnet-4-5")
   *   - OpenCode: "provider/model" (e.g. "anthropic/claude-sonnet-4")
   * When omitted the provider uses its auto-detected default.
   * This is the "strong" tier model used by executor and spec agents.
   */
  model?: string;
  /**
   * Provider for the "fast" (cost-saving) tier used by planner and commit agents.
   * Defaults to `provider` when omitted.
   */
  fastProvider?: ProviderName;
  /**
   * Model for the "fast" (cost-saving) tier, in provider-specific format.
   * Used by planner and commit agents to reduce costs.
   * Defaults to `model` when omitted.
   */
  fastModel?: string;
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
  /**
   * Per-agent provider/model overrides. Each agent role can independently
   * specify a provider and model. Missing fields inherit from the top-level
   * `provider`/`model` (or `fastProvider`/`fastModel` for planner/commit).
   *
   * Example:
   * ```json
   * {
   *   "provider": "claude",
   *   "model": "claude-sonnet-4",
   *   "agents": {
   *     "planner": { "provider": "copilot", "model": "claude-haiku-4" },
   *     "commit": { "model": "claude-haiku-4" }
   *   }
   * }
   * ```
   */
  agents?: Partial<Record<AgentName, AgentConfig>>;
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
export const CONFIG_KEYS = ["provider", "model", "fastProvider", "fastModel", "agents", "source", "planTimeout", "specTimeout", "specWarnTimeout", "specKillTimeout", "concurrency", "org", "project", "workItemType", "iteration", "area", "username"] as const;

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

    case "model":
    case "fastModel":
      if (!value || value.trim() === "") {
        return `Invalid ${key}: value must not be empty`;
      }
      return null;

    case "fastProvider":
      if (!PROVIDER_NAMES.includes(value as ProviderName)) {
        return `Invalid fastProvider "${value}". Available: ${PROVIDER_NAMES.join(", ")}`;
      }
      return null;

    case "agents":
      // agents is an object, not a scalar — skip string-level validation.
      // Structural validation happens at load time.
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
    }  }
}

/** Valid agent role names for per-agent config. */
const AGENT_NAMES: AgentName[] = ["planner", "executor", "spec", "commit"];

/** Agent roles that default to the fast tier when fastProvider/fastModel are set. */
const FAST_ROLES: AgentName[] = ["planner", "commit"];

/**
 * Resolve the effective provider+model for a given agent role.
 *
 * Priority: `agents.<role>` > `fastProvider`/`fastModel` (planner/commit only) > top-level.
 */
export function resolveAgentProviderConfig(
  role: AgentName,
  opts: {
    provider: ProviderName;
    model?: string;
    fastProvider?: ProviderName;
    fastModel?: string;
    agents?: Partial<Record<AgentName, AgentConfig>>;
  },
): { provider: ProviderName; model?: string } {
  const override = opts.agents?.[role];
  const isFastRole = FAST_ROLES.includes(role);
  return {
    provider: override?.provider ?? (isFastRole ? opts.fastProvider : undefined) ?? opts.provider,
    model: override?.model ?? (isFastRole ? opts.fastModel : undefined) ?? opts.model,
  };
}

/** All valid agent role names. Exported for config wizard use. */
export { AGENT_NAMES };

/**
 * Handle the `dispatch config` subcommand.
 *
 * Launches the interactive configuration wizard.
 */
export async function handleConfigCommand(_argv: string[], configDir?: string): Promise<void> {
  await runInteractiveConfigWizard(configDir);
}
