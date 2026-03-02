import { describe, it, expect, afterEach, vi } from "vitest";
import { select, input, confirm, number } from "@inquirer/prompts";
import { runInteractiveConfigWizard } from "../config-prompts.js";
import { loadConfig, saveConfig } from "../config.js";

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
    );
  });
});
