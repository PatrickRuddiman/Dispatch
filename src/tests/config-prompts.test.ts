import { describe, it, expect, afterEach, vi } from "vitest";
import { select, input, confirm, number } from "@inquirer/prompts";
import { runInteractiveConfigWizard } from "../config-prompts.js";
import { loadConfig, saveConfig } from "../config.js";
import { detectDatasource } from "../datasources/index.js";
import { detectWorkItemType } from "../datasources/azdevops.js";
import { listProviderModels, checkProviderInstalled } from "../providers/index.js";
import chalk from "chalk";

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
  number: vi.fn(),
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
  };
});

vi.mock("../datasources/azdevops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../datasources/azdevops.js")>();
  return {
    ...actual,
    detectWorkItemType: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  return {
    ...actual,
    listProviderModels: vi.fn().mockResolvedValue([]),
    checkProviderInstalled: vi.fn().mockResolvedValue(true),
  };
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── runInteractiveConfigWizard ──────────────────────────────────────

describe("runInteractiveConfigWizard", () => {
  it("basic flow — selects provider and datasource, saves config", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "copilot", source: "github" }),
      undefined,
    );
    // No reconfigure prompt since config was empty
    expect(confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Do you want to reconfigure?" }),
    );
  });

  it("model selection — saves selected model when provider returns models", async () => {
    vi.mocked(listProviderModels).mockResolvedValueOnce(["model-a", "model-b"]);
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")   // provider
      .mockResolvedValueOnce("model-a")   // model
      .mockResolvedValueOnce("github");   // datasource
    vi.mocked(confirm)
      .mockResolvedValueOnce(false)  // advanced settings
      .mockResolvedValueOnce(true);  // save
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "copilot",
        model: "model-a",
        source: "github",
      }),
      undefined,
    );
  });

  it("model selection — default option omits model from config", async () => {
    vi.mocked(listProviderModels).mockResolvedValueOnce(["model-a", "model-b"]);
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")   // provider
      .mockResolvedValueOnce("")          // model — "default (provider decides)"
      .mockResolvedValueOnce("github");   // datasource
    vi.mocked(confirm)
      .mockResolvedValueOnce(false)  // advanced settings
      .mockResolvedValueOnce(true);  // save
    await runInteractiveConfigWizard();
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0];
    expect(savedConfig.provider).toBe("copilot");
    expect(savedConfig.source).toBe("github");
    expect(savedConfig.model).toBeUndefined();
  });

  it("conditional Azure DevOps prompts for org and project", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("opencode")
      .mockResolvedValueOnce("azdevops");
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")
      .mockResolvedValueOnce("my-project")
      .mockResolvedValueOnce("User Story");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(input).toHaveBeenCalledTimes(3);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        source: "azdevops",
        org: "https://dev.azure.com/myorg",
        project: "my-project",
        workItemType: "User Story",
      }),
      undefined,
    );
  });

  it("non-azdevops datasource does NOT prompt for org/project", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(input).not.toHaveBeenCalled();
  });

  it("existing config — user declines reconfiguration", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      provider: "opencode",
      source: "github",
    });
    vi.mocked(confirm).mockResolvedValueOnce(false); // reconfigure
    await runInteractiveConfigWizard();
    expect(select).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("user cancels at save confirmation", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(false); // save — declined
    await runInteractiveConfigWizard();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("advanced settings flow prompts for all advanced fields", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // advanced settings
      .mockResolvedValueOnce(true); // save
    vi.mocked(number)
      .mockResolvedValueOnce(4) // concurrency
      .mockResolvedValueOnce(10) // planTimeout
      .mockResolvedValueOnce(2) // retries
      .mockResolvedValueOnce(2); // planRetries
    vi.mocked(input).mockResolvedValueOnce("http://localhost:3000"); // serverUrl
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "copilot",
        source: "github",
        concurrency: 4,
        serverUrl: "http://localhost:3000",
        planTimeout: 10,
        retries: 2,
        planRetries: 2,
      }),
      undefined,
    );
  });

  it("existing config — user accepts reconfiguration", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      provider: "opencode",
      source: "github",
    });
    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // reconfigure
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("md");
    await runInteractiveConfigWizard();
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "copilot", source: "md" }),
      undefined,
    );
  });

  it("default is auto when no existing source (regardless of detection)", async () => {
    vi.mocked(detectDatasource).mockResolvedValueOnce("github");
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
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
    vi.mocked(loadConfig).mockResolvedValueOnce({ source: "azdevops" });
    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // reconfigure
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("azdevops");
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/org")
      .mockResolvedValueOnce("proj")
      .mockResolvedValueOnce("User Story");
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
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("md");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a datasource:",
        default: "auto",
      }),
    );
  });

  it("selecting auto saves config without source field", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("auto");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0];
    expect(savedConfig.source).toBeUndefined();
    expect(savedConfig.provider).toBe("copilot");
  });

  it("azdevops flow uses detected work item type as default", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(detectWorkItemType).mockResolvedValueOnce("Product Backlog Item");
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("azdevops");
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")
      .mockResolvedValueOnce("my-project")
      .mockResolvedValueOnce("Product Backlog Item");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(detectWorkItemType).toHaveBeenCalledWith({
      org: "https://dev.azure.com/myorg",
      project: "my-project",
    });
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Work item type:",
        default: "Product Backlog Item",
      }),
    );
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workItemType: "Product Backlog Item" }),
      undefined,
    );
  });

  it("azdevops flow falls back to existing config workItemType when detection fails", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({ workItemType: "Requirement" });
    vi.mocked(detectWorkItemType).mockResolvedValueOnce(null);
    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // reconfigure
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("azdevops");
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")
      .mockResolvedValueOnce("my-project")
      .mockResolvedValueOnce("Requirement");
    await runInteractiveConfigWizard();
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Work item type:",
        default: "Requirement",
      }),
    );
  });

  it("datasource choices include auto as first option", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const datasourceCall = vi.mocked(select).mock.calls[1][0];
    expect(datasourceCall.choices[0]).toMatchObject({ name: "auto", value: "auto" });
  });

  it("provider select choices include install indicator annotations", async () => {
    vi.mocked(checkProviderInstalled).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const providerCall = vi.mocked(select).mock.calls[0][0];
    for (const choice of providerCall.choices as Array<{ name: string; value: string }>) {
      expect(choice.name).toBe(
        `${chalk.green("●")} ${choice.value}`,
      );
    }
  });

  it("provider select choices show red indicator for uninstalled providers", async () => {
    vi.mocked(checkProviderInstalled).mockImplementation(
      async (name) => name !== "copilot",
    );
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("github");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const providerCall = vi.mocked(select).mock.calls[0][0];
    const choices = providerCall.choices as Array<{ name: string; value: string }>;
    const copilotChoice = choices.find(
      (c) => c.value === "copilot",
    );
    expect(copilotChoice!.name).toBe(`${chalk.red("●")} copilot`);
    const otherChoices = choices.filter(
      (c) => c.value !== "copilot",
    );
    for (const choice of otherChoices) {
      expect(choice.name).toBe(
        `${chalk.green("●")} ${choice.value}`,
      );
    }
  });
});
