import { describe, it, expect, afterEach, vi } from "vitest";
import { select, input, confirm, number } from "@inquirer/prompts";
import { runInteractiveConfigWizard } from "../config-prompts.js";
import { loadConfig, saveConfig } from "../config.js";
import { detectDatasource } from "../datasources/index.js";

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

  it("conditional Azure DevOps prompts for org and project", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("opencode")
      .mockResolvedValueOnce("azdevops");
    vi.mocked(input)
      .mockResolvedValueOnce("https://dev.azure.com/myorg")
      .mockResolvedValueOnce("my-project");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // advanced settings
      .mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    expect(input).toHaveBeenCalledTimes(2);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        source: "azdevops",
        org: "https://dev.azure.com/myorg",
        project: "my-project",
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
});
