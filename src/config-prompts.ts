/**
 * Interactive configuration wizard for Dispatch.
 *
 * Guides users through provider, datasource, and advanced settings
 * configuration via an interactive terminal flow.
 */

import { select, input, confirm, number } from "@inquirer/prompts";
import chalk from "chalk";
import { log } from "./helpers/logger.js";
import {
  loadConfig,
  saveConfig,
  validateConfigValue,
  type DispatchConfig,
} from "./config.js";
import { PROVIDER_NAMES, listProviderModels, checkProviderInstalled } from "./providers/index.js";
import type { ProviderName } from "./providers/interface.js";
import { DATASOURCE_NAMES, detectDatasource } from "./datasources/index.js";
import type { DatasourceName } from "./datasources/interface.js";
import { detectWorkItemType } from "./datasources/azdevops.js";

/**
 * Run the interactive configuration wizard.
 *
 * Loads existing config, walks the user through provider and datasource
 * selection, conditionally prompts for Azure DevOps fields, offers
 * advanced settings, displays a summary, and saves on confirmation.
 */
export async function runInteractiveConfigWizard(configDir?: string): Promise<void> {
  console.log();
  log.info(chalk.bold("Dispatch Configuration Wizard"));
  console.log();

  // ── Load existing config ───────────────────────────────────
  const existing = await loadConfig(configDir);
  const hasExisting = Object.keys(existing).length > 0;

  if (hasExisting) {
    log.dim("Current configuration:");
    for (const [key, value] of Object.entries(existing)) {
      if (value !== undefined) {
        log.dim(`  ${key} = ${value}`);
      }
    }
    console.log();

    const reconfigure = await confirm({
      message: "Do you want to reconfigure?",
      default: true,
    });

    if (!reconfigure) {
      log.dim("Configuration unchanged.");
      return;
    }
    console.log();
  }

  // ── Provider selection ─────────────────────────────────────
  const installStatuses = await Promise.all(
    PROVIDER_NAMES.map((name) => checkProviderInstalled(name)),
  );

  const provider = await select<ProviderName>({
    message: "Select a provider:",
    choices: PROVIDER_NAMES.map((name, i) => ({
      name: `${installStatuses[i] ? chalk.green("●") : chalk.red("●")} ${name}`,
      value: name,
    })),
    default: existing.provider,
  });

  // ── Model selection ────────────────────────────────────────
  let selectedModel: string | undefined = existing.model;
  try {
    log.dim("Fetching available models...");
    const serverUrl = existing.serverUrl;
    const models = await listProviderModels(
      provider,
      serverUrl ? { url: serverUrl } : undefined,
    );
    if (models.length > 0) {
      const modelChoice = await select<string>({
        message: "Select a model:",
        choices: [
          { name: "default (provider decides)", value: "" },
          ...models.map((m) => ({ name: m, value: m })),
        ],
        default: existing.model ?? "",
      });
      selectedModel = modelChoice || undefined;
    } else {
      log.dim("No models returned by provider — skipping model selection.");
      selectedModel = existing.model;
    }
  } catch {
    log.dim("Could not list models (provider may not be running) — skipping model selection.");
    selectedModel = existing.model;
  }

  // ── Auto-detect datasource from git remote ─────────────────
  const detectedSource = await detectDatasource(process.cwd());
  const datasourceDefault: DatasourceName | "auto" = existing.source ?? "auto";
  if (detectedSource) {
    log.info(
      `Detected datasource ${chalk.cyan(detectedSource)} from git remote`,
    );
  }

  // ── Datasource selection ───────────────────────────────────
  const selectedSource = await select<DatasourceName | "auto">({
    message: "Select a datasource:",
    choices: [
      {
        name: "auto",
        value: "auto" as const,
        description: "detect from git remote at runtime",
      },
      ...DATASOURCE_NAMES.map((name) => ({ name, value: name })),
    ],
    default: datasourceDefault,
  });
  const source: DatasourceName | undefined =
    selectedSource === "auto" ? undefined : selectedSource;

  // ── Azure DevOps-specific fields ───────────────────────────
  let org: string | undefined;
  let project: string | undefined;
  let workItemType: string | undefined;

  if (source === "azdevops") {
    org = await input({
      message: "Azure DevOps organization URL:",
      default: existing.org,
      validate: (value) => {
        const error = validateConfigValue("org", value);
        return error ?? true;
      },
    });

    project = await input({
      message: "Azure DevOps project name:",
      default: existing.project,
      validate: (value) => {
        const error = validateConfigValue("project", value);
        return error ?? true;
      },
    });

    const detectedType = await detectWorkItemType({ org, project });
    workItemType = await input({
      message: "Work item type:",
      default: existing.workItemType ?? detectedType ?? undefined,
      validate: (value) => {
        const error = validateConfigValue("workItemType", value);
        return error ?? true;
      },
    });
  }

  // ── Advanced settings ──────────────────────────────────────
  let concurrency: number | undefined = existing.concurrency;
  let serverUrl: string | undefined = existing.serverUrl;
  let planTimeout: number | undefined = existing.planTimeout;
  let planRetries: number | undefined = existing.planRetries;
  let retries: number | undefined = existing.retries;

  console.log();
  const configureAdvanced = await confirm({
    message: "Configure advanced settings?",
    default: false,
  });

  if (configureAdvanced) {
    const concurrencyResult = await number({
      message: "Concurrency (max parallel dispatches):",
      default: existing.concurrency,
      validate: (value) => {
        if (value === undefined) return true;
        const error = validateConfigValue("concurrency", String(value));
        return error ?? true;
      },
    });
    concurrency = concurrencyResult;

    serverUrl = await input({
      message: "Server URL (leave empty to skip):",
      default: existing.serverUrl ?? "",
    });
    if (serverUrl.trim() === "") {
      serverUrl = undefined;
    }

    const planTimeoutResult = await number({
      message: "Plan timeout in minutes:",
      default: existing.planTimeout,
      validate: (value) => {
        if (value === undefined) return true;
        const error = validateConfigValue("planTimeout", String(value));
        return error ?? true;
      },
    });
    planTimeout = planTimeoutResult;

    const retriesResult = await number({
      message: "Retries (retry attempts for all agents):",
      default: existing.retries,
      validate: (value) => {
        if (value === undefined) return true;
        const error = validateConfigValue("retries", String(value));
        return error ?? true;
      },
    });
    retries = retriesResult;

    const planRetriesResult = await number({
      message: "Plan retries:",
      default: existing.planRetries,
      validate: (value) => {
        if (value === undefined) return true;
        const error = validateConfigValue("planRetries", String(value));
        return error ?? true;
      },
    });
    planRetries = planRetriesResult;
  }

  // ── Build new config ───────────────────────────────────────
  const newConfig: DispatchConfig = {
    ...existing,
    provider,
    source,
  };

  if (selectedModel !== undefined) {
    newConfig.model = selectedModel;
  } else {
    delete newConfig.model;
  }

  if (org !== undefined) newConfig.org = org;
  if (project !== undefined) newConfig.project = project;
  if (workItemType !== undefined) newConfig.workItemType = workItemType;
  if (concurrency !== undefined) newConfig.concurrency = concurrency;
  if (serverUrl !== undefined) newConfig.serverUrl = serverUrl;
  if (planTimeout !== undefined) newConfig.planTimeout = planTimeout;
  if (retries !== undefined) newConfig.retries = retries;
  if (planRetries !== undefined) newConfig.planRetries = planRetries;

  // ── Summary ────────────────────────────────────────────────
  console.log();
  log.info(chalk.bold("Configuration summary:"));
  for (const [key, value] of Object.entries(newConfig)) {
    if (value !== undefined) {
      console.log(`  ${chalk.cyan(key)} = ${value}`);
    }
  }
  if (selectedSource === "auto") {
    console.log(
      `  ${chalk.cyan("source")} = auto (detect from git remote at runtime)`,
    );
  }
  console.log();

  // ── Confirm and save ───────────────────────────────────────
  const shouldSave = await confirm({
    message: "Save this configuration?",
    default: true,
  });

  if (shouldSave) {
    await saveConfig(newConfig, configDir);
    log.success("Configuration saved.");
  } else {
    log.dim("Configuration not saved.");
  }
}
