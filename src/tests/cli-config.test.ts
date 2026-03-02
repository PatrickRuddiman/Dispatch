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
  },
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
}));

import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { log } from "../helpers/logger.js";
import { loadConfig } from "../config.js";
import type { RawCliArgs } from "../orchestrator/runner.js";

function createRawCliArgs(overrides?: Partial<RawCliArgs>): RawCliArgs {
  return {
    issueIds: [],
    dryRun: false,
    noPlan: false,
    noBranch: false,
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

    it("exits when source is not configured and not in fix-tests mode", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ provider: "copilot" });

      const args = createRawCliArgs({
        explicitFlags: new Set(),
        provider: undefined as never,
        issueSource: undefined,
      });

      await expect(resolveCliConfig(args)).rejects.toThrow(
        "process.exit called",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("source"),
      );
    });

    it("exits with both missing when neither provider nor source is configured", async () => {
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
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("source"),
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
