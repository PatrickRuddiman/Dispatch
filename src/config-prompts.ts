/**
 * Interactive configuration wizard for Dispatch.
 *
 * Guides users through provider, datasource, and model selection
 * via an interactive terminal flow.
 */

import { select, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { log } from "./helpers/logger.js";
import {
  loadConfig,
  saveConfig,
  type DispatchConfig,
} from "./config.js";
import { PROVIDER_NAMES, listProviderModels } from "./providers/index.js";
import type { ProviderName } from "./providers/interface.js";
import { DATASOURCE_NAMES, detectDatasource } from "./datasources/index.js";
import type { DatasourceName } from "./datasources/interface.js";

/**
 * Run the interactive configuration wizard.
 *
 * Loads existing config, walks the user through provider, model, and
 * datasource selection, displays a summary, and saves on confirmation.
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
  const provider = await select<ProviderName>({
    message: "Select a provider:",
    choices: PROVIDER_NAMES.map((name) => ({ name, value: name })),
    default: existing.provider,
  });

  // ── Model selection ────────────────────────────────────────
  let selectedModel: string | undefined = existing.model;
  try {
    log.dim("Fetching available models...");
    const models = await listProviderModels(provider);
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

  // ── Build new config ───────────────────────────────────────
  const newConfig: DispatchConfig = {
    provider,
    source,
  };

  if (selectedModel !== undefined) {
    newConfig.model = selectedModel;
  }

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
