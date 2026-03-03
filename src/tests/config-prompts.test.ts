import { describe, it, expect, afterEach, vi } from "vitest";
import { select, confirm } from "@inquirer/prompts";
import { runInteractiveConfigWizard } from "../config-prompts.js";
import { loadConfig, saveConfig } from "../config.js";
import { detectDatasource } from "../datasources/index.js";
import { listProviderModels } from "../providers/index.js";

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  confirm: vi.fn(),
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

vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  return {
    ...actual,
    listProviderModels: vi.fn().mockResolvedValue([]),
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
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
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
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
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
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0];
    expect(savedConfig.provider).toBe("copilot");
    expect(savedConfig.source).toBe("github");
    expect(savedConfig.model).toBeUndefined();
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
    vi.mocked(confirm).mockResolvedValueOnce(false); // save — declined
    await runInteractiveConfigWizard();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("existing config — user accepts reconfiguration", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      provider: "opencode",
      source: "github",
    });
    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // reconfigure
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
    vi.mocked(loadConfig).mockResolvedValueOnce({ source: "azdevops" });
    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // reconfigure
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
    vi.mocked(loadConfig).mockResolvedValueOnce({});
    vi.mocked(select)
      .mockResolvedValueOnce("copilot")
      .mockResolvedValueOnce("auto");
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
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
    vi.mocked(confirm).mockResolvedValueOnce(true); // save
    await runInteractiveConfigWizard();
    const datasourceCall = vi.mocked(select).mock.calls[1][0];
    expect(datasourceCall.choices[0]).toMatchObject({ name: "auto", value: "auto" });
  });
});
