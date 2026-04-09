import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { select, confirm, input } from "@inquirer/prompts";
import { runInteractiveConfigWizard } from "../config-prompts.js";
import { loadConfig, saveConfig } from "../config.js";
import { detectDatasource, getGitRemoteUrl, parseAzDevOpsRemoteUrl } from "../datasources/index.js";
import { getProviderStatuses } from "../providers/registry.js";
import { setupProviderAuth } from "../providers/auth-setup.js";
import { ensureAuthReady } from "../helpers/auth.js";

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockResolvedValue({}),
    saveConfig: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../datasources/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../datasources/index.js")>();
  return {
    ...actual,
    detectDatasource: vi.fn().mockResolvedValue(null),
    getGitRemoteUrl: vi.fn().mockResolvedValue(null),
    parseAzDevOpsRemoteUrl: vi.fn().mockReturnValue(null),
  };
});

vi.mock("../providers/registry.js", () => ({
  getProviderStatuses: vi.fn().mockResolvedValue([]),
}));

vi.mock("../providers/auth-setup.js", () => ({
  setupProviderAuth: vi.fn().mockResolvedValue(true),
}));

vi.mock("../helpers/auth.js", () => ({
  ensureAuthReady: vi.fn().mockResolvedValue(undefined),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

/** Helper to build a provider status entry. */
function providerStatus(
  name: "copilot" | "claude" | "codex" | "opencode",
  displayName: string,
  authStatus: "authenticated" | "not-configured" | "expired" = "authenticated",
) {
  return {
    name,
    displayName,
    tier: "free" as const,
    defaultStrongModel: "model-strong",
    defaultFastModel: "model-fast",
    costScore: { strong: 1, fast: 1 },
    checkAuth: vi.fn(),
    authStatus:
      authStatus === "authenticated"
        ? { status: "authenticated" as const }
        : { status: authStatus as "not-configured" | "expired", hint: "set up auth" },
  };
}

/** Default statuses: copilot authenticated, others not. */
function defaultProviderStatuses() {
  return [
    providerStatus("copilot", "GitHub Copilot", "authenticated"),
    providerStatus("claude", "Claude Code", "not-configured"),
    providerStatus("codex", "OpenAI Codex", "not-configured"),
    providerStatus("opencode", "OpenCode", "not-configured"),
  ];
}

/** All providers authenticated. */
function allAuthenticatedStatuses() {
  return [
    providerStatus("copilot", "GitHub Copilot", "authenticated"),
    providerStatus("claude", "Claude Code", "authenticated"),
    providerStatus("codex", "OpenAI Codex", "authenticated"),
    providerStatus("opencode", "OpenCode", "authenticated"),
  ];
}

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  vi.mocked(loadConfig).mockResolvedValue({});
  vi.mocked(saveConfig).mockResolvedValue(undefined);
  vi.mocked(detectDatasource).mockResolvedValue(null);
  vi.mocked(getGitRemoteUrl).mockResolvedValue(null);
  vi.mocked(parseAzDevOpsRemoteUrl).mockReturnValue(null);
  vi.mocked(input).mockResolvedValue("");
  vi.mocked(ensureAuthReady).mockResolvedValue(undefined);
  vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
  vi.mocked(setupProviderAuth).mockResolvedValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── runInteractiveConfigWizard ──────────────────────────────────────

describe("runInteractiveConfigWizard", () => {
  it("basic flow — detects providers and selects datasource, saves config with enabledProviders", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledProviders: ["copilot", "claude", "codex", "opencode"],
        source: "github",
      }),
      undefined,
    );
    // No reconfigure prompt since config was empty
    expect(confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Do you want to reconfigure?" }),
    );
  });

  it("existing config — user declines reconfiguration", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      enabledProviders: ["copilot"],
      source: "github",
    });
    vi.mocked(confirm).mockResolvedValueOnce(false); // reconfigure
    await runInteractiveConfigWizard();
    expect(select).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("existing config — user accepts reconfiguration", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      enabledProviders: ["copilot"],
      source: "github",
    });
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)  // reconfigure
      .mockResolvedValueOnce(true); // save
    vi.mocked(select).mockResolvedValueOnce("md"); // datasource
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledProviders: ["copilot", "claude", "codex", "opencode"],
      }),
      undefined,
    );
  });

  it("user cancels at save confirmation", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(false); // save — declined
    await runInteractiveConfigWizard();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  // ─── Provider auth setup ─────────────────────────────────────────

  it("prompts to set up auth for unauthenticated providers", async () => {
    const statuses = defaultProviderStatuses();
    vi.mocked(getProviderStatuses)
      .mockResolvedValueOnce(statuses)       // initial check
      .mockResolvedValueOnce(statuses);      // re-check after setup
    vi.mocked(confirm)
      .mockResolvedValueOnce(false)  // set up Claude auth — decline
      .mockResolvedValueOnce(false)  // set up Codex auth — decline
      .mockResolvedValueOnce(false)  // set up OpenCode auth — decline
      .mockResolvedValueOnce(true);  // save
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    await runInteractiveConfigWizard();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Set up authentication for Claude Code?" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Set up authentication for OpenAI Codex?" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Set up authentication for OpenCode?" }),
    );
    expect(setupProviderAuth).not.toHaveBeenCalled();
  });

  it("calls setupProviderAuth when user accepts auth setup", async () => {
    const statuses = defaultProviderStatuses();
    vi.mocked(getProviderStatuses)
      .mockResolvedValueOnce(statuses)                   // initial check
      .mockResolvedValueOnce(allAuthenticatedStatuses()); // re-check after setup
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)   // set up Claude auth — accept
      .mockResolvedValueOnce(false)  // set up Codex auth — decline
      .mockResolvedValueOnce(false)  // set up OpenCode auth — decline
      .mockResolvedValueOnce(true);  // save
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    await runInteractiveConfigWizard();
    expect(setupProviderAuth).toHaveBeenCalledWith("claude");
    expect(setupProviderAuth).not.toHaveBeenCalledWith("codex");
  });

  it("exits early when no providers are authenticated", async () => {
    const noAuth = [
      providerStatus("copilot", "GitHub Copilot", "not-configured"),
      providerStatus("claude", "Claude Code", "not-configured"),
      providerStatus("codex", "OpenAI Codex", "not-configured"),
      providerStatus("opencode", "OpenCode", "not-configured"),
    ];
    vi.mocked(getProviderStatuses)
      .mockResolvedValueOnce(noAuth)  // initial
      .mockResolvedValueOnce(noAuth); // re-check
    vi.mocked(confirm)
      .mockResolvedValueOnce(false)  // Claude auth — decline
      .mockResolvedValueOnce(false)  // Codex auth — decline
      .mockResolvedValueOnce(false)  // OpenCode auth — decline
      .mockResolvedValueOnce(false); // Copilot auth — decline
    await runInteractiveConfigWizard();
    expect(select).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("saves only authenticated providers in enabledProviders", async () => {
    const statuses = defaultProviderStatuses(); // only copilot authenticated
    vi.mocked(getProviderStatuses)
      .mockResolvedValueOnce(statuses)
      .mockResolvedValueOnce(statuses);
    vi.mocked(confirm)
      .mockResolvedValueOnce(false)  // Claude auth — decline
      .mockResolvedValueOnce(false)  // Codex auth — decline
      .mockResolvedValueOnce(false)  // OpenCode auth — decline
      .mockResolvedValueOnce(true);  // save
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledProviders: ["copilot"],
      }),
      undefined,
    );
  });

  // ─── Datasource selection ────────────────────────────────────────

  it("default is auto when no existing source (regardless of detection)", async () => {
    vi.mocked(detectDatasource).mockResolvedValueOnce("github");
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a datasource:",
        default: "auto",
      }),
    );
  });

  it("existing config source takes precedence over auto-detected", async () => {
    vi.mocked(detectDatasource).mockResolvedValueOnce("github");
    vi.mocked(loadConfig).mockResolvedValue({ source: "azdevops" });
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)  // reconfigure
      .mockResolvedValueOnce(true); // save
    vi.mocked(select).mockResolvedValueOnce("azdevops"); // datasource
    await runInteractiveConfigWizard();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a datasource:",
        default: "azdevops",
      }),
    );
  });

  it("default is auto when no existing source and no detection", async () => {
    vi.mocked(detectDatasource).mockResolvedValueOnce(null);
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("md"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a datasource:",
        default: "auto",
      }),
    );
  });

  it("selecting auto saves config without source field", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("auto"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0];
    expect(savedConfig.source).toBeUndefined();
    expect(savedConfig.enabledProviders).toBeDefined();
  });

  it("datasource choices include auto as first option", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const datasourceCall = vi.mocked(select).mock.calls[0][0];
    expect(datasourceCall.choices[0]).toMatchObject({ name: "auto", value: "auto" });
  });

  // ─── Azure DevOps ────────────────────────────────────────────────

  it("azdevops source — prompts for org, project, workItemType, iteration, area", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("azdevops"); // datasource
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")  // org
      .mockResolvedValueOnce("MyProject")                     // project
      .mockResolvedValueOnce("User Story")                    // workItemType
      .mockResolvedValueOnce("@CurrentIteration")             // iteration
      .mockResolvedValueOnce("MyProject\\Team A");            // area
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledProviders: expect.any(Array),
        source: "azdevops",
        org: "https://dev.azure.com/myorg",
        project: "MyProject",
        workItemType: "User Story",
        iteration: "@CurrentIteration",
        area: "MyProject\\Team A",
      }),
      undefined,
    );
  });

  it("azdevops source — empty inputs omit fields from config", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("azdevops"); // datasource
    vi.mocked(input)
      .mockResolvedValueOnce("")   // org — skip
      .mockResolvedValueOnce("")   // project — skip
      .mockResolvedValueOnce("")   // workItemType — skip
      .mockResolvedValueOnce("")   // iteration — skip
      .mockResolvedValueOnce("");  // area — skip
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0];
    expect(savedConfig.org).toBeUndefined();
    expect(savedConfig.project).toBeUndefined();
    expect(savedConfig.workItemType).toBeUndefined();
    expect(savedConfig.iteration).toBeUndefined();
    expect(savedConfig.area).toBeUndefined();
  });

  it("azdevops source — pre-fills org and project from git remote", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(getGitRemoteUrl).mockResolvedValueOnce("https://dev.azure.com/myorg/MyProject/_git/myrepo");
    vi.mocked(parseAzDevOpsRemoteUrl).mockReturnValueOnce({
      orgUrl: "https://dev.azure.com/myorg",
      project: "MyProject",
    });
    vi.mocked(select).mockResolvedValueOnce("azdevops"); // datasource
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")  // org (pre-filled)
      .mockResolvedValueOnce("MyProject")                     // project (pre-filled)
      .mockResolvedValueOnce("")                               // workItemType — skip
      .mockResolvedValueOnce("")                               // iteration — skip
      .mockResolvedValueOnce("");                              // area — skip
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Organization URL:",
        default: "https://dev.azure.com/myorg",
      }),
    );
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project name:",
        default: "MyProject",
      }),
    );
  });

  it("non-azdevops source — does not prompt for azdevops fields", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(input).not.toHaveBeenCalled();
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0];
    expect(savedConfig.org).toBeUndefined();
    expect(savedConfig.project).toBeUndefined();
  });

  // ─── Datasource auth ─────────────────────────────────────────────

  it("triggers auth when github datasource is selected", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(ensureAuthReady).toHaveBeenCalledWith("github", process.cwd(), undefined);
  });

  it("triggers auth when azdevops datasource is selected with org", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("azdevops"); // datasource
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")  // org
      .mockResolvedValueOnce("MyProject")                     // project
      .mockResolvedValueOnce("")                               // workItemType
      .mockResolvedValueOnce("")                               // iteration
      .mockResolvedValueOnce("");                              // area
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(ensureAuthReady).toHaveBeenCalledWith("azdevops", process.cwd(), "https://dev.azure.com/myorg");
  });

  it("does not trigger auth for md datasource", async () => {
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("md"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(ensureAuthReady).toHaveBeenCalledWith("md", process.cwd(), undefined);
  });

  it("continues wizard when datasource auth fails", async () => {
    vi.mocked(ensureAuthReady).mockRejectedValueOnce(new Error("auth failed"));
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("github"); // datasource
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledProviders: expect.any(Array),
        source: "github",
      }),
      undefined,
    );
  });

  it("triggers auth for auto-detected github source when auto is selected", async () => {
    vi.mocked(detectDatasource).mockResolvedValueOnce("github");
    vi.mocked(loadConfig).mockResolvedValue({});
    vi.mocked(getProviderStatuses).mockResolvedValue(allAuthenticatedStatuses());
    vi.mocked(select).mockResolvedValueOnce("auto"); // auto selected, but detected as github
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(ensureAuthReady).toHaveBeenCalledWith("github", process.cwd(), undefined);
  });
});
