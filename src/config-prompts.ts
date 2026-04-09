/**
 * Interactive configuration wizard for Dispatch.
 *
 * Guides users through provider, datasource, and model selection
 * via an interactive terminal flow.
 */

import { select, confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { log } from "./helpers/logger.js";
import {
  loadConfig,
  saveConfig,
  AGENT_NAMES,
  type DispatchConfig,
  type AgentConfig,
} from "./config.js";
import type { AgentName } from "./agents/interface.js";
import { PROVIDER_NAMES, listProviderModels, checkProviderInstalled } from "./providers/index.js";
import type { ProviderName } from "./providers/interface.js";
import {
  DATASOURCE_NAMES,
  detectDatasource,
  getGitRemoteUrl,
  parseAzDevOpsRemoteUrl,
} from "./datasources/index.js";
import type { DatasourceName } from "./datasources/interface.js";
import { ensureAuthReady } from "./helpers/auth.js";

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

  // ── Per-agent provider/model overrides ──────────────────────
  const agentOverrides: Partial<Record<AgentName, AgentConfig>> = {};
  const hasExistingAgents = existing.agents && Object.keys(existing.agents).length > 0;

  const useAgentOverrides = await confirm({
    message: "Configure per-agent provider/model overrides? (advanced, saves cost)",
    default: hasExistingAgents ?? false,
  });

  if (useAgentOverrides) {
    console.log();
    log.dim(`Each agent inherits from the top-level provider (${provider}) unless overridden.`);
    console.log();

    for (const role of AGENT_NAMES) {
      const existingAgent = existing.agents?.[role];
      const wantOverride = await confirm({
        message: `Override ${role} agent?`,
        default: existingAgent !== undefined,
      });

      if (!wantOverride) continue;

      // Provider selection for this agent
      const agentProvider = await select<ProviderName | "">({
        message: `  ${role} — provider:`,
        choices: [
          { name: `inherit (${provider})`, value: "" },
          ...PROVIDER_NAMES.map((name, i) => ({
            name: `${installStatuses[i] ? chalk.green("●") : chalk.red("●")} ${name}`,
            value: name,
          })),
        ],
        default: existingAgent?.provider ?? "",
      });

      // Model selection for this agent
      const effectiveProvider = (agentProvider || provider) as ProviderName;
      let agentModel: string | undefined;
      try {
        const agentModels = await listProviderModels(effectiveProvider);
        if (agentModels.length > 0) {
          const modelChoice = await select<string>({
            message: `  ${role} — model:`,
            choices: [
              { name: "inherit (top-level model)", value: "" },
              ...agentModels.map((m) => ({ name: m, value: m })),
            ],
            default: existingAgent?.model ?? "",
          });
          agentModel = modelChoice || undefined;
        }
      } catch {
        log.dim(`  Could not list models for ${effectiveProvider} — skipping model selection.`);
        agentModel = existingAgent?.model;
      }

      // Only store if something differs from top-level
      if (agentProvider || agentModel) {
        const cfg: AgentConfig = {};
        if (agentProvider) cfg.provider = agentProvider as ProviderName;
        if (agentModel) cfg.model = agentModel;
        agentOverrides[role] = cfg;
      }
    }
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
  let iteration: string | undefined;
  let area: string | undefined;

  const effectiveSource = source ?? detectedSource;
  if (effectiveSource === "azdevops") {
    // Try to pre-fill org and project from git remote
    let defaultOrg = existing.org ?? "";
    let defaultProject = existing.project ?? "";
    try {
      const remoteUrl = await getGitRemoteUrl(process.cwd());
      if (remoteUrl) {
        const parsed = parseAzDevOpsRemoteUrl(remoteUrl);
        if (parsed) {
          if (!defaultOrg) defaultOrg = parsed.orgUrl;
          if (!defaultProject) defaultProject = parsed.project;
        }
      }
    } catch {
      // ignore — pre-fill is best-effort
    }

    console.log();
    log.info(chalk.bold("Azure DevOps settings") + chalk.dim(" (leave empty to skip):"));

    const orgInput = await input({
      message: "Organization URL:",
      default: defaultOrg || undefined,
    });
    if (orgInput.trim()) org = orgInput.trim();

    const projectInput = await input({
      message: "Project name:",
      default: defaultProject || undefined,
    });
    if (projectInput.trim()) project = projectInput.trim();

    const workItemTypeInput = await input({
      message: "Work item type (e.g. User Story, Bug):",
      default: existing.workItemType ?? undefined,
    });
    if (workItemTypeInput.trim()) workItemType = workItemTypeInput.trim();

    const iterationInput = await input({
      message: "Iteration path (e.g. MyProject\\Sprint 1, or @CurrentIteration):",
      default: existing.iteration ?? undefined,
    });
    if (iterationInput.trim()) iteration = iterationInput.trim();

    const areaInput = await input({
      message: "Area path (e.g. MyProject\\Team A):",
      default: existing.area ?? undefined,
    });
    if (areaInput.trim()) area = areaInput.trim();
  }

  // ── Authenticate tracker-backed datasource ────────────────
  try {
    await ensureAuthReady(effectiveSource ?? undefined, process.cwd(), org);
  } catch (err) {
    log.warn(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn("You can re-run 'dispatch config' or authenticate later at runtime.");
  }

  // ── Merge prompted fields onto existing config ─────────────
  const existingConfig = await loadConfig(configDir);
  const newConfig: DispatchConfig = {
    ...existingConfig,
    provider,
    source,
  };

  if (selectedModel !== undefined) {
    newConfig.model = selectedModel;
  }
  if (Object.keys(agentOverrides).length > 0) {
    newConfig.agents = agentOverrides;
  }
  if (org !== undefined) newConfig.org = org;
  if (project !== undefined) newConfig.project = project;
  if (workItemType !== undefined) newConfig.workItemType = workItemType;
  if (iteration !== undefined) newConfig.iteration = iteration;
  if (area !== undefined) newConfig.area = area;

  // ── Summary ────────────────────────────────────────────────
  console.log();
  log.info(chalk.bold("Configuration summary:"));
  for (const [key, value] of Object.entries(newConfig)) {
    if (value !== undefined) {
      if (key === "agents" && typeof value === "object") {
        console.log(`  ${chalk.cyan("agents")}:`);
        for (const [role, cfg] of Object.entries(value as Record<string, AgentConfig>)) {
          const parts: string[] = [];
          if (cfg.provider) parts.push(`provider=${cfg.provider}`);
          if (cfg.model) parts.push(`model=${cfg.model}`);
          console.log(`    ${chalk.cyan(role)} = ${parts.join(", ")}`);
        }
      } else {
        console.log(`  ${chalk.cyan(key)} = ${value}`);
      }
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
