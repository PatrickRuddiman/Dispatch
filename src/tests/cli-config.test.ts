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

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("../datasources/index.js", () => ({
  detectDatasource: vi.fn().mockResolvedValue(null),
  DATASOURCE_NAMES: ["github", "azdevops", "md"],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn() };
});

import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { log } from "../helpers/logger.js";
import { loadConfig } from "../config.js";
import { detectDatasource, DATASOURCE_NAMES } from "../datasources/index.js";
import { access } from "node:fs/promises";
import type { RawCliArgs } from "../orchestrator/runner.js";

function createRawCliArgs(overrides?: Partial<RawCliArgs>): RawCliArgs {
  return {
    issueIds: [],
    dryRun: false,
    noPlan: false,
    noBranch: false,
    noWorktree: false,
    force: false,
    provider: undefined,
    enabledProviders: ["copilot"],
    cwd: "/tmp/test-cwd",
    verbose: false,
    explicitFlags: new Set(["enabledProviders", "issueSource"]),
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

      expect(result.enabledProviders).toEqual(["copilot"]);
      expect(result.issueSource).toBe("md");
      expect(result.cwd).toBe("/tmp/test-cwd");
    });

    it("merges config defaults for fields not in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["opencode"],
        source: "github",
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
      });
      const result = await resolveCliConfig(args);

      expect(result.enabledProviders).toEqual(["opencode"]);
      expect(result.issueSource).toBe("github");
    });

    it("CLI flags take precedence over config values when in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["opencode"],
        source: "github",
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
        enabledProviders: ["copilot"],
        issueSource: "md",
      });
      const result = await resolveCliConfig(args);

      expect(result.enabledProviders).toEqual(["copilot"]);
      expect(result.issueSource).toBe("md");
    });

    it("merges source config key to issueSource CLI field", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ source: "github" });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders"]),
      });
      const result = await resolveCliConfig(args);

      expect(result.issueSource).toBe("github");
    });

    it("does not overwrite explicit issueSource with config source", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ source: "github" });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
        issueSource: "md",
      });
      const result = await resolveCliConfig(args);

      expect(result.issueSource).toBe("md");
    });

    it("merges all CONFIG_TO_CLI fields from config", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["opencode"],
        source: "azdevops",
        specTimeout: 12,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
      });
      const result = await resolveCliConfig(args);

      expect(result.enabledProviders).toEqual(["opencode"]);
      expect(result.issueSource).toBe("azdevops");
      expect(result.specTimeout).toBe(12);
    });

    it("merges specTimeout from config when not explicit", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        specTimeout: 9,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
      });
      const result = await resolveCliConfig(args);

      expect(result.specTimeout).toBe(9);
    });

    it("keeps explicit CLI specTimeout over config value", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        specTimeout: 9,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource", "specTimeout"]),
        specTimeout: 15,
      });
      const result = await resolveCliConfig(args);

      expect(result.specTimeout).toBe(15);
    });

    it("merges specWarnTimeout from config when not explicit", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        specWarnTimeout: 8,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
      });
      const result = await resolveCliConfig(args);

      expect(result.specWarnTimeout).toBe(8);
    });

    it("keeps explicit CLI specWarnTimeout over config value", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        specWarnTimeout: 8,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource", "specWarnTimeout"]),
        specWarnTimeout: 15,
      });
      const result = await resolveCliConfig(args);

      expect(result.specWarnTimeout).toBe(15);
    });

    it("merges specKillTimeout from config when not explicit", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        specKillTimeout: 5,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
      });
      const result = await resolveCliConfig(args);

      expect(result.specKillTimeout).toBe(5);
    });

    it("keeps explicit CLI specKillTimeout over config value", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        specKillTimeout: 5,
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource", "specKillTimeout"]),
        specKillTimeout: 12,
      });
      const result = await resolveCliConfig(args);

      expect(result.specKillTimeout).toBe(12);
    });

    it("merges azdevops config values (org, project, workItemType, iteration, area) when not in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        source: "azdevops",
        org: "my-org",
        project: "my-project",
        workItemType: "Bug",
        iteration: "Sprint 1",
        area: "Team\\Frontend",
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
      });
      const result = await resolveCliConfig(args);

      expect(result.org).toBe("my-org");
      expect(result.project).toBe("my-project");
      expect(result.workItemType).toBe("Bug");
      expect(result.iteration).toBe("Sprint 1");
      expect(result.area).toBe("Team\\Frontend");
    });

    it("CLI flags take precedence over config for org, project, workItemType, iteration, area", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        source: "azdevops",
        org: "config-org",
        project: "config-project",
        workItemType: "Bug",
        iteration: "Sprint 1",
        area: "Team\\Backend",
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource", "org", "project", "workItemType", "iteration", "area"]),
        issueSource: "azdevops",
        org: "cli-org",
        project: "cli-project",
        workItemType: "User Story",
        iteration: "Sprint 2",
        area: "Team\\Frontend",
      });
      const result = await resolveCliConfig(args);

      expect(result.org).toBe("cli-org");
      expect(result.project).toBe("cli-project");
      expect(result.workItemType).toBe("User Story");
      expect(result.iteration).toBe("Sprint 2");
      expect(result.area).toBe("Team\\Frontend");
    });

    it("merges only the azdevops config fields that are set, leaving others undefined", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        source: "azdevops",
        org: "my-org",
        project: "my-project",
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
      });
      const result = await resolveCliConfig(args);

      expect(result.org).toBe("my-org");
      expect(result.project).toBe("my-project");
      expect(result.workItemType).toBeUndefined();
      expect(result.iteration).toBeUndefined();
      expect(result.area).toBeUndefined();
    });

    it("uses config for azdevops fields not in explicitFlags and CLI for those in explicitFlags", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
        source: "azdevops",
        org: "config-org",
        project: "config-project",
        iteration: "Sprint 1",
        area: "Team\\Backend",
      });

      const args = createRawCliArgs({
        explicitFlags: new Set(["org", "project"]),
        org: "cli-org",
        project: "cli-project",
      });
      const result = await resolveCliConfig(args);

      expect(result.org).toBe("cli-org");
      expect(result.project).toBe("cli-project");
      expect(result.iteration).toBe("Sprint 1");
      expect(result.area).toBe("Team\\Backend");
    });
  });

  describe("validation warnings", () => {
    it("warns when neither provider nor enabledProviders is configured", async () => {
      const args = createRawCliArgs({
        explicitFlags: new Set(["issueSource"]),
        issueSource: "md",
        provider: undefined,
        enabledProviders: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("No providers configured"),
      );
      expect(process.exit).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("md");
    });

    it("does not warn when provider is set via CLI flag", async () => {
      const args = createRawCliArgs({
        explicitFlags: new Set(["provider", "issueSource"]),
        provider: "copilot",
        enabledProviders: undefined,
        issueSource: "md",
      });

      await resolveCliConfig(args);
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("No providers configured"),
      );
    });

    it("does not warn when enabledProviders is set", async () => {
      const args = createRawCliArgs({
        explicitFlags: new Set(["issueSource"]),
        issueSource: "md",
        enabledProviders: ["copilot"],
      });

      await resolveCliConfig(args);
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("No providers configured"),
      );
    });

    it("auto-detects datasource when source is not configured", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("github");
      expect(detectDatasource).toHaveBeenCalledWith(args.cwd);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Auto-detected datasource from git remote: github"),
      );
    });
  });

  describe("output-dir validation", () => {
    it("exits with error when output directory does not exist", async () => {
      vi.mocked(access).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );

      const args = createRawCliArgs({ outputDir: "/nonexistent/path" });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("--output-dir"),
      );
    });

    it("exits with error when output directory is not writable", async () => {
      vi.mocked(access).mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
      );

      const args = createRawCliArgs({ outputDir: "/readonly/path" });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("--output-dir"),
      );
    });

    it("passes validation when output directory exists and is writable", async () => {
      vi.mocked(access).mockResolvedValueOnce(undefined);

      const args = createRawCliArgs({ outputDir: "/valid/writable/path" });

      const result = await resolveCliConfig(args);
      expect(log.error).not.toHaveBeenCalled();
      expect(process.exit).not.toHaveBeenCalled();
      expect(result.outputDir).toBe("/valid/writable/path");
    });

    it("skips validation when outputDir is not set", async () => {
      const args = createRawCliArgs();

      await resolveCliConfig(args);
      expect(access).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
      expect(process.exit).not.toHaveBeenCalled();
    });
  });

  describe("datasource auto-detection", () => {
    it("uses detected datasource when source is not explicitly set", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
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
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue(null);

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
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
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
        provider: undefined,
        issueSource: "azdevops",
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("azdevops");
      expect(detectDatasource).not.toHaveBeenCalled();
    });

    it("does not auto-detect when config source is set", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"], source: "github" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(result.issueSource).toBe("github");
      expect(detectDatasource).not.toHaveBeenCalled();
    });

    it("skips auto-detection in spec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
        issueSource: undefined,
        spec: "drafts/*.md",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBeUndefined();
    });

    it("skips auto-detection in respec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
        issueSource: undefined,
        respec: "1,2",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBeUndefined();
    });

    it("still auto-detects for dispatch mode (no spec/respec)", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
        issueSource: undefined,
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).toHaveBeenCalledWith("/tmp/test-cwd");
      expect(result.issueSource).toBe("github");
    });

    it("explicit --source flag still works in spec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
        issueSource: "github",
        spec: "1,2",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("github");
    });

    it("config-file source still applies in spec mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"], source: "azdevops" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
        issueSource: undefined,
        spec: "drafts/*.md",
      });

      const result = await resolveCliConfig(args);
      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("azdevops");
    });

    it("detects azdevops from git remote", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue("azdevops");

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined,
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
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders"]),
        issueSource: undefined,
      });
      const result = await resolveCliConfig(args);

      expect(detectDatasource).toHaveBeenCalledWith("/tmp/test-cwd");
      expect(result.issueSource).toBe("github");
    });

    it("exits with error when no explicit source is set and detection fails", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue(null);

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders"]),
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
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue(null);

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders"]),
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
        expect.stringContaining("--source"),
      );
    });

    it("explicit --source flag overrides auto-detection", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ enabledProviders: ["copilot"] });
      vi.mocked(detectDatasource).mockResolvedValue("github");

      const args = createRawCliArgs({
        explicitFlags: new Set(["enabledProviders", "issueSource"]),
        issueSource: "azdevops",
      });
      const result = await resolveCliConfig(args);

      expect(detectDatasource).not.toHaveBeenCalled();
      expect(result.issueSource).toBe("azdevops");
    });

    it("config source value overrides auto-detection", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        enabledProviders: ["copilot"],
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
