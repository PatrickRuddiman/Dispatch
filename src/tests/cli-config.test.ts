import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../helpers/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    task: vi.fn(),
    verbose: false,
    formatErrorChain: vi.fn().mockReturnValue(""),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("../datasources/index.js", () => ({
  detectDatasource: vi.fn().mockResolvedValue(null),
  DATASOURCE_NAMES: ["github", "azdevops", "md"],
}));

import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { log } from "../helpers/logger.js";
import { loadConfig } from "../config.js";
import { detectDatasource, DATASOURCE_NAMES } from "../datasources/index.js";
import type { RawCliArgs } from "../orchestrator/runner.js";

function createRawCliArgs(overrides?: Partial<RawCliArgs>): RawCliArgs {
  return {
    issueIds: [],
    dryRun: false,
    noPlan: false,
    noBranch: false,
    noWorktree: false,
    force: false,
    provider: "copilot",
    cwd: "/tmp/test-cwd",
    verbose: false,
    explicitFlags: new Set(["provider", "issueSource"]),
    issueSource: "md",
    ...overrides,
  };
}

describe("resolveCliConfig()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit called");
      }) as never,
    );
    vi.mocked(loadConfig).mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config merging", () => {
    it("returns args unchanged when config file is empty", async () => {
      const args = createRawCliArgs();
      const result = await resolveCliConfig(args);

      expect(result.provider).toBe("copilot");
      expect(result.issueSource).toBe("md");
      expect(result.cwd).toBe("/tmp/test-cwd");
    });

    it("merges config defaults for fields not in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        concurrency: 5,
        org: "my-org",
        planTimeout: 10,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource"]),
      });
      const result = await resolveCliConfig(args);

      expect(result.concurrency).toBe(5);
      expect(result.org).toBe("my-org");
      expect(result.planTimeout).toBe(10);
    });

    it("CLI flags take precedence over config values when in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        provider: "opencode",
        concurrency: 8,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "concurrency", "issueSource"]),
        provider: "copilot",
        concurrency: 3,
      });
      const result = await resolveCliConfig(args);

      expect(result.provider).toBe("copilot");
      expect(result.concurrency).toBe(3);
    });

    it("merges source config key to issueSource CLI field", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ source: "github" });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider"]),
      });
      const result = await resolveCliConfig(args);

      expect(result.issueSource).toBe("github");
    });

    it("does not overwrite explicit issueSource with config source", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ source: "github" });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource"]),
        issueSource: "md",
      });
      const result = await resolveCliConfig(args);

      expect(result.issueSource).toBe("md");
    });

    it("merges all CONFIG_TO_CLI fields from config", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        provider: "opencode",
        concurrency: 4,
        source: "azdevops",
        org: "test-org",
        project: "test-proj",
        workItemType: "User Story",
        serverUrl: "https://example.com",
        planTimeout: 15,
        planRetries: 3,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
      });
      const result = await resolveCliConfig(args);

      expect(result.provider).toBe("opencode");
      expect(result.concurrency).toBe(4);
      expect(result.issueSource).toBe("azdevops");
      expect(result.org).toBe("test-org");
      expect(result.project).toBe("test-proj");
      expect(result.workItemType).toBe("User Story");
      expect(result.serverUrl).toBe("https://example.com");
      expect(result.planTimeout).toBe(15);
      expect(result.planRetries).toBe(3);
    });
  });

  describe("validation errors", () => {
    it("exits when provider is not configured", async () => {
      const args = createRawCliArgs({
        explicitFlags: new Set(["issueSource"]),
        issueSource: "md",
        provider: undefined as never,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("provider"),
      );
    });

    it("auto-detects datasource when source is not configured", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("github");
      expect(detectDatasource).toHaveBeenCalledWith(args.cwd);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Auto-detected datasource from git remote: github"),
      );
    });

    it("exits when only provider is missing (source is auto-detected)", async () => {
      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("provider"),
      );
    });

    it("does not require source in fix-tests mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
        fixTests: true,
      });

      const result = await resolveCliConfig(args);
      expect(process.exit).not.toHaveBeenCalled();
      expect(result.provider).toBe("copilot");
    });

    it("still requires provider in fix-tests mode", async () => {
      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
        fixTests: true,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("provider"),
      );
    });
  });

  describe("datasource auto-detection", () => {
    it("uses detected datasource when source is not explicitly set", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("github");
      expect(detectDatasource).toHaveBeenCalledWith("/tmp/test-cwd");
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Auto-detected datasource from git remote: github"),
      );
    });

    it("exits with error when detection returns null", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue(null);

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("auto-detection failed"),
      );
    });

    it("does not auto-detect when issueSource is in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource"]),
        provider: undefined as never,
        issueSource: "azdevops",
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("azdevops");
      expect(detectDatasource).not.toHaveBeenCalled();
    });

    it("does not auto-detect when config source is set", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot", source: "github" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("github");
      expect(detectDatasource).not.toHaveBeenCalled();
    });

    it("skips auto-detection in fix-tests mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
        fixTests: true,
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBeUndefined();
    });

    it("skips auto-detection in spec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
        spec: "drafts/*.md",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBeUndefined();
    });

    it("skips auto-detection in respec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
        respec: "1,2",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBeUndefined();
    });

    it("still auto-detects for dispatch mode (no spec/respec)", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).toHaveBeenCalledWith("/tmp/test-cwd");
      expect(result.issueSource).toBe("github");
    });

    it("explicit --source flag still works in spec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource"]),
        issueSource: "github",
        spec: "1,2",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("github");
    });

    it("config-file source still applies in spec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot", source: "azdevops" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
        spec: "drafts/*.md",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("azdevops");
    });

    it("detects azdevops from git remote", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue("azdevops");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("azdevops");
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Auto-detected datasource from git remote: azdevops"),
      );
    });
  });

  describe("datasource auto-detection", () => {
    it("uses detected source when no explicit source is set and detection succeeds", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider"]),
        issueSource: undefined,
      });
      const result = await resolveCliConfig(args);

      expect(detectDatasource).toHaveBeenCalledWith("/tmp/test-cwd");
      expect(result.issueSource).toBe("github");
    });

    it("exits with error when no explicit source is set and detection fails", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue(null);

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider"]),
        issueSource: undefined,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(detectDatasource).toHaveBeenCalledWith("/tmp/test-cwd");
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("auto-detection failed"),
      );
    });

    it("includes remediation guidance when detection fails", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue(null);

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider"]),
        issueSource: undefined,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.dim).toHaveBeenCalledWith(
        expect.stringContaining("github, azdevops, md"),
      );
      expect(log.dim).toHaveBeenCalledWith(
        expect.stringContaining("dispatch config"),
      );
      expect(log.dim).toHaveBeenCalledWith(
        expect.stringContaining("--issue-source"),
      );
    });

    it("explicit --source flag overrides auto-detection", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource"]),
        issueSource: "azdevops",
      });
      const result = await resolveCliConfig(args);

      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("azdevops");
    });

    it("config source value overrides auto-detection", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        provider: "copilot",
        source: "azdevops",
      });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        issueSource: undefined,
      });
      const result = await resolveCliConfig(args);

      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("azdevops");
    });
  });

  describe("verbose logging", () => {
    it("enables verbose logging when verbose is true", async () => {
      const args = createRawCliArgs({ verbose: true });
      await resolveCliConfig(args);

      expect(log.verbose).toBe(true);
    });

    it("does not enable verbose logging when verbose is false", async () => {
      const args = createRawCliArgs({ verbose: false });
      await resolveCliConfig(args);

      expect(log.verbose).toBe(false);
    });
  });

  describe("default handling", () => {
    it("passes through all non-config CLI fields unchanged", async () => {
      const args = createRawCliArgs({
        issueIds: ["1", "2"],
        dryRun: true,
        noPlan: true,
        noBranch: true,
        cwd: "/custom",
        spec: "1,2",
      });

      const result = await resolveCliConfig(args);

      expect(result.issueIds).toEqual(["1", "2"]);
      expect(result.dryRun).toBe(true);
      expect(result.noPlan).toBe(true);
      expect(result.noBranch).toBe(true);
      expect(result.cwd).toBe("/custom");
      expect(result.spec).toBe("1,2");
    });
  });
});
