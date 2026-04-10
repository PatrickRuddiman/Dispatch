/**
 * Interactive configuration wizard for Dispatch.
 *
 * Walks users through provider auth setup and datasource selection.
 * Provider/model selection is handled automatically by the smart router —
 * the user just needs to authenticate the providers they want to use.
 */

import { select, confirm, input, multiSelect } from "./helpers/ink-prompts.js";
import { log } from "./helpers/logger.js";
import {
  loadConfig,
  saveConfig,
  type DispatchConfig,
  type ProviderModelConfig,
} from "./config.js";
import {
  DATASOURCE_NAMES,
  detectDatasource,
  getGitRemoteUrl,
  parseAzDevOpsRemoteUrl,
} from "./datasources/index.js";
import type { DatasourceName } from "./datasources/interface.js";
import { ensureAuthReady } from "./helpers/auth.js";
import type { ProviderName } from "./providers/interface.js";
import { listProviderModels } from "./providers/index.js";
import { getProviderStatuses, type AuthStatus, PROVIDER_REGISTRY } from "./providers/registry.js";
import { setupProviderAuth } from "./providers/auth-setup.js";

/** Timeout for fetching provider model lists (ms). */
const MODEL_LIST_TIMEOUT_MS = 8_000;

/** Format auth status with a colored indicator. */
function formatAuthStatus(status: AuthStatus): string {
  switch (status.status) {
    case "authenticated":
      return "authenticated";
    case "not-configured":
      return "not configured";
    case "expired":
      return "expired";
  }
}

/**
 * Run the interactive configuration wizard.
 *
 * Detects provider auth status, guides through auth setup,
 * then handles datasource selection and saves the config.
 */
export async function runInteractiveConfigWizard(configDir?: string): Promise<void> {
  console.log();
  log.info("Dispatch Setup");
  console.log();

  // ── Load existing config ───────────────────────────────────
  const existing = await loadConfig(configDir);
  const hasExisting = Object.keys(existing).length > 0;

  if (hasExisting) {
    log.dim("Current configuration:");
    for (const [key, value] of Object.entries(existing)) {
      if (value !== undefined) {
        if (key === "enabledProviders" && Array.isArray(value)) {
          log.dim(`  ${key} = ${(value as string[]).join(", ")}`);
        } else {
          log.dim(`  ${key} = ${value}`);
        }
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

  // ── Provider auth detection ───────────────────────────────
  log.info("Detecting provider authentication status...");
  console.log();

  let providerStatuses = await getProviderStatuses();

  // Display status table
  for (const ps of providerStatuses) {
    const tierLabel = ps.tier === "free" ? "(free tier)" : "(API key)";
    const statusLabel = formatAuthStatus(ps.authStatus);
    const indicator = ps.authStatus.status === "authenticated" ? "  ✓" : "  ✗";
    console.log(`${indicator}  ${ps.displayName.padEnd(18)} ${statusLabel}  ${tierLabel}`);
  }
  console.log();

  // ── Provider selection ─────────────────────────────────────
  const selectedProviders = await multiSelect<ProviderName>({
    message: "Select providers to enable:",
    choices: providerStatuses.map((ps) => {
      const isAuth = ps.authStatus.status === "authenticated";
      return {
        name: ps.displayName,
        value: ps.name,
        description: isAuth ? "authenticated" : "not yet authenticated",
        default: isAuth,
      };
    }),
  });

  if (selectedProviders.length === 0) {
    log.error("At least one provider must be enabled to use Dispatch.");
    log.dim("Re-run 'dispatch config' to enable providers.");
    return;
  }

  // ── Auth setup for selected-but-unauthenticated providers ──
  const needsAuth = selectedProviders.filter((name) => {
    const ps = providerStatuses.find((p) => p.name === name);
    return ps && ps.authStatus.status !== "authenticated";
  });

  if (needsAuth.length > 0) {
    console.log();
    for (const name of needsAuth) {
      console.log();
      await setupProviderAuth(name);
      console.log();
    }

    // Re-check status after setup
    providerStatuses = await getProviderStatuses();
  }

  // Final enabled list = selected providers that are now authenticated
  const enabledProviders = selectedProviders.filter((name) => {
    const ps = providerStatuses.find((p) => p.name === name);
    return ps && ps.authStatus.status === "authenticated";
  });

  if (enabledProviders.length === 0) {
    log.error("At least one provider must be authenticated to use Dispatch.");
    log.dim("Re-run 'dispatch config' after setting up provider credentials.");
    return;
  }

  // Show final status
  console.log();
  log.info("Provider status:");
  for (const ps of providerStatuses) {
    const isEnabled = enabledProviders.includes(ps.name);
    const indicator = isEnabled ? "✓" : "✗";
    console.log(`  ${indicator} ${ps.displayName}`);
  }
  console.log();

  log.info(
    `${enabledProviders.length} provider(s) enabled. ` +
    `Dispatch will automatically route tasks to the best available provider.`,
  );
  console.log();

  // ── Per-provider model selection (opt-in) ─────────────────
  const providerModels: Partial<Record<ProviderName, ProviderModelConfig>> =
    existing.providerModels ? { ...existing.providerModels } : {};

  const configureModels = await confirm({
    message: `Configure model selection for ${enabledProviders.length} provider(s)?`,
    default: false,
  });

  if (configureModels) {
    for (const name of enabledProviders) {
      const meta = PROVIDER_REGISTRY[name];
      const existingOverride = providerModels[name];
      console.log();
      log.info(`${meta.displayName} models:`);

      // Fetch available models with timeout
      let models: string[];
      try {
        log.dim(`  Fetching available models...`);
        models = await Promise.race([
          listProviderModels(name),
          new Promise<string[]>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), MODEL_LIST_TIMEOUT_MS),
          ),
        ]);
      } catch {
        log.warn(`  Could not fetch model list — showing defaults only`);
        models = [meta.defaultStrongModel, meta.defaultFastModel];
      }

      // Deduplicate and ensure defaults are in the list
      const modelSet = new Set(models);
      modelSet.add(meta.defaultStrongModel);
      modelSet.add(meta.defaultFastModel);
      const allModels = [...modelSet].sort();

      // Strong model selection
      const strongDefault = existingOverride?.strong ?? meta.defaultStrongModel;
      const strongChoice = await select<string | undefined>({
        message: "Strong model (executor, spec):",
        choices: [
          { name: `(default) ${meta.defaultStrongModel}`, value: undefined },
          ...allModels.map((m) => ({ name: m, value: m })),
        ],
        default: strongDefault === meta.defaultStrongModel ? undefined : strongDefault,
      });

      // Fast model selection
      const fastDefault = existingOverride?.fast ?? meta.defaultFastModel;
      const fastChoice = await select<string | undefined>({
        message: "Fast model (planner, commit):",
        choices: [
          { name: `(default) ${meta.defaultFastModel}`, value: undefined },
          ...allModels.map((m) => ({ name: m, value: m })),
        ],
        default: fastDefault === meta.defaultFastModel ? undefined : fastDefault,
      });

      // Save overrides (omit if user chose default)
      const entry: ProviderModelConfig = {};
      if (strongChoice !== undefined) entry.strong = strongChoice;
      if (fastChoice !== undefined) entry.fast = fastChoice;
      if (entry.strong !== undefined || entry.fast !== undefined) {
        providerModels[name] = entry;
      } else {
        delete providerModels[name];
      }
    }
  }
  console.log();

  // ── Auto-detect datasource from git remote ─────────────────
  const detectedSource = await detectDatasource(process.cwd());
  const datasourceDefault: DatasourceName | "auto" = existing.source ?? "auto";
  if (detectedSource) {
    log.info(`Detected datasource ${detectedSource} from git remote`);
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
    log.info("Azure DevOps settings (leave empty to skip):");

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

  // ── Build new config ──────────────────────────────────────
  const existingConfig = await loadConfig(configDir);
  const newConfig: DispatchConfig = {
    ...existingConfig,
    enabledProviders,
    source,
  };

  // Save provider model overrides (or clear if empty)
  if (Object.keys(providerModels).length > 0) {
    newConfig.providerModels = providerModels;
  } else {
    delete newConfig.providerModels;
  }

  if (org !== undefined) newConfig.org = org;
  if (project !== undefined) newConfig.project = project;
  if (workItemType !== undefined) newConfig.workItemType = workItemType;
  if (iteration !== undefined) newConfig.iteration = iteration;
  if (area !== undefined) newConfig.area = area;

  // ── Summary ────────────────────────────────────────────────
  console.log();
  log.info("Configuration summary:");
  for (const [key, value] of Object.entries(newConfig)) {
    if (value !== undefined) {
      if (key === "enabledProviders" && Array.isArray(value)) {
        console.log(`  ${key} = ${(value as string[]).join(", ")}`);
      } else if (key === "providerModels" && typeof value === "object") {
        for (const [provider, models] of Object.entries(value as Record<string, ProviderModelConfig>)) {
          const parts: string[] = [];
          if (models.strong) parts.push(`strong=${models.strong}`);
          if (models.fast) parts.push(`fast=${models.fast}`);
          if (parts.length) console.log(`  ${provider} models = ${parts.join(", ")}`);
        }
      } else {
        console.log(`  ${key} = ${value}`);
      }
    }
  }
  if (selectedSource === "auto") {
    console.log(`  source = auto (detect from git remote at runtime)`);
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
