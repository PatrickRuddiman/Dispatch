/**
 * Interactive configuration wizard for Dispatch.
 *
 * Walks users through provider auth setup and datasource selection.
 * Provider/model selection is handled automatically by the smart router —
 * the user just needs to authenticate the providers they want to use.
 */

import { select, confirm, input } from "./helpers/ink-prompts.js";
import { log } from "./helpers/logger.js";
import {
  loadConfig,
  saveConfig,
  type DispatchConfig,
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
import { getProviderStatuses, type AuthStatus } from "./providers/registry.js";
import { setupProviderAuth } from "./providers/auth-setup.js";

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
  log.info("Select which providers you want to enable:");
  console.log();

  const selectedProviders: ProviderName[] = [];
  for (const ps of providerStatuses) {
    const isAuth = ps.authStatus.status === "authenticated";
    const suffix = !isAuth ? " (not yet authenticated)" : "";
    const enable = await confirm({
      message: `Enable ${ps.displayName}?${suffix}`,
      default: isAuth,
    });
    if (enable) selectedProviders.push(ps.name);
  }

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
