import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFile, mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  isValidConfigKey,
  validateConfigValue,
  parseConfigValue,
  CONFIG_KEYS,
  handleConfigCommand,
  type DispatchConfig,
} from "../config.js";

// ─── Config file I/O ─────────────────────────────────────────────────

describe("loadConfig", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty object when config file does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const result = await loadConfig(tmpDir);
    expect(result).toEqual({});
  });

  it("returns empty object for empty config file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await writeFile(join(tmpDir, "config.json"), "", "utf-8");
    const result = await loadConfig(tmpDir);
    expect(result).toEqual({});
  });

  it("loads a valid config file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const config = { provider: "copilot", concurrency: 3 };
    await writeFile(join(tmpDir, "config.json"), JSON.stringify(config), "utf-8");
    const result = await loadConfig(tmpDir);
    expect(result).toEqual({ provider: "copilot", concurrency: 3 });
  });

  it("returns empty object for corrupt JSON", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await writeFile(join(tmpDir, "config.json"), "not json { broken", "utf-8");
    const result = await loadConfig(tmpDir);
    expect(result).toEqual({});
  });

  it("loads config with all fields populated", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const config: DispatchConfig = {
      provider: "copilot",
      concurrency: 5,
      source: "azdevops",
      org: "my-org",
      project: "my-project",
      serverUrl: "http://localhost:3000",
    };
    await writeFile(join(tmpDir, "config.json"), JSON.stringify(config), "utf-8");
    const result = await loadConfig(tmpDir);
    expect(result).toEqual(config);
  });
});

// ─── saveConfig ──────────────────────────────────────────────────────

describe("saveConfig", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("saves config and round-trips correctly", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const config: DispatchConfig = {
      provider: "copilot",
      concurrency: 4,
      source: "github",
      org: "test-org",
      project: "test-project",
      serverUrl: "http://localhost:8080",
    };
    await saveConfig(config, tmpDir);
    const loaded = await loadConfig(tmpDir);
    expect(loaded).toEqual(config);
  });

  it("creates parent directory if it doesn't exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const configDir = join(tmpDir, "nested", "subdir");
    const config: DispatchConfig = { provider: "opencode" };
    await saveConfig(config, configDir);
    const raw = await readFile(join(configDir, "config.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(config);
  });

  it("writes pretty-printed JSON with trailing newline", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const config: DispatchConfig = { provider: "copilot" };
    await saveConfig(config, tmpDir);
    const raw = await readFile(join(tmpDir, "config.json"), "utf-8");
    expect(raw).toBe(JSON.stringify({ provider: "copilot" }, null, 2) + "\n");
  });

  it("overwrites existing config", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await saveConfig({ provider: "opencode", concurrency: 2 }, tmpDir);
    await saveConfig({ provider: "copilot" }, tmpDir);
    const loaded = await loadConfig(tmpDir);
    expect(loaded).toEqual({ provider: "copilot" });
  });
});

// ─── getConfigPath ───────────────────────────────────────────────────

describe("getConfigPath", () => {
  it("returns path under the given directory", () => {
    expect(getConfigPath("/custom/dir")).toBe("/custom/dir/config.json");
  });

  it("defaults to ~/.dispatch/config.json when no override", () => {
    const result = getConfigPath();
    expect(result).toMatch(/^.+\.dispatch\/config\.json$/);
  });
});

// ─── isValidConfigKey ────────────────────────────────────────────────

describe("isValidConfigKey", () => {
  it("returns true for each valid config key", () => {
    for (const key of CONFIG_KEYS) {
      expect(isValidConfigKey(key)).toBe(true);
    }
  });

  it("returns false for unknown keys", () => {
    for (const key of ["unknown", "dryRun", "noPlan", "verbose", ""]) {
      expect(isValidConfigKey(key)).toBe(false);
    }
  });
});

// ─── validateConfigValue ─────────────────────────────────────────────

describe("validateConfigValue", () => {
  it("accepts valid provider names", () => {
    expect(validateConfigValue("provider", "opencode")).toBe(null);
    expect(validateConfigValue("provider", "copilot")).toBe(null);
  });

  it("rejects invalid provider name", () => {
    const result = validateConfigValue("provider", "invalid");
    expect(result).not.toBe(null);
    expect(result).toContain("Invalid provider");
  });

  it("accepts valid source names", () => {
    expect(validateConfigValue("source", "github")).toBe(null);
    expect(validateConfigValue("source", "azdevops")).toBe(null);
  });

  it("rejects invalid source name", () => {
    const result = validateConfigValue("source", "jira");
    expect(result).not.toBe(null);
    expect(result).toContain("Invalid source");
  });

  it("accepts valid concurrency (positive integer)", () => {
    expect(validateConfigValue("concurrency", "1")).toBe(null);
    expect(validateConfigValue("concurrency", "5")).toBe(null);
    expect(validateConfigValue("concurrency", "100")).toBe(null);
  });

  it("rejects non-positive concurrency", () => {
    const zero = validateConfigValue("concurrency", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("positive integer");

    const negative = validateConfigValue("concurrency", "-1");
    expect(negative).not.toBe(null);
    expect(negative).toContain("positive integer");
  });

  it("rejects non-integer concurrency", () => {
    const decimal = validateConfigValue("concurrency", "1.5");
    expect(decimal).not.toBe(null);

    const text = validateConfigValue("concurrency", "abc");
    expect(text).not.toBe(null);
  });

  it("accepts non-empty string for org, project, serverUrl", () => {
    for (const key of ["org", "project", "serverUrl"] as const) {
      expect(validateConfigValue(key, "some-value")).toBe(null);
    }
  });

  it("rejects empty string for org, project, serverUrl", () => {
    for (const key of ["org", "project", "serverUrl"] as const) {
      const result = validateConfigValue(key, "");
      expect(result).not.toBe(null);
      expect(result).toContain("must not be empty");
    }
  });

  it("rejects whitespace-only for org, project, serverUrl", () => {
    for (const key of ["org", "project", "serverUrl"] as const) {
      const result = validateConfigValue(key, "   ");
      expect(result).not.toBe(null);
      expect(result).toContain("must not be empty");
    }
  });
});

// ─── parseConfigValue ────────────────────────────────────────────────

describe("parseConfigValue", () => {
  it("converts concurrency to a number", () => {
    const result = parseConfigValue("concurrency", "5");
    expect(result).toBe(5);
    expect(typeof result).toBe("number");
  });

  it("returns string for non-concurrency keys", () => {
    const result = parseConfigValue("provider", "copilot");
    expect(result).toBe("copilot");
    expect(typeof result).toBe("string");
  });
});

// ─── Merge precedence (CLI > config > default) ─────────────────────

describe("merge precedence", () => {
  /**
   * Mapping from config keys to their corresponding CLI args field names.
   * This mirrors the merge logic in main() in src/cli.ts.
   */
  const CONFIG_TO_CLI: Record<string, string> = {
    provider: "provider",
    concurrency: "concurrency",
    source: "issueSource",
    org: "org",
    project: "project",
    serverUrl: "serverUrl",
  };

  /** Applies the merge logic: config fills in where CLI flag is not explicit. */
  function applyMerge(
    args: Record<string, unknown>,
    config: DispatchConfig,
    explicitFlags: Set<string>,
  ): void {
    for (const [configKey, cliField] of Object.entries(CONFIG_TO_CLI)) {
      const configValue = config[configKey as keyof DispatchConfig];
      if (configValue !== undefined && !explicitFlags.has(cliField)) {
        args[cliField] = configValue;
      }
    }
  }

  it("config value fills in when CLI flag is not explicit", () => {
    const args: Record<string, unknown> = { provider: "opencode" };
    const config: DispatchConfig = { provider: "copilot" };
    const explicitFlags = new Set<string>();
    applyMerge(args, config, explicitFlags);
    expect(args.provider).toBe("copilot");
  });

  it("CLI flag takes precedence over config", () => {
    const args: Record<string, unknown> = { provider: "opencode" };
    const config: DispatchConfig = { provider: "copilot" };
    const explicitFlags = new Set<string>(["provider"]);
    applyMerge(args, config, explicitFlags);
    expect(args.provider).toBe("opencode");
  });

  it("default is used when neither CLI nor config provides a value", () => {
    const args: Record<string, unknown> = { provider: "opencode" };
    const config: DispatchConfig = {};
    const explicitFlags = new Set<string>();
    applyMerge(args, config, explicitFlags);
    expect(args.provider).toBe("opencode");
  });

  it("merge applies to each configurable field", () => {
    const args: Record<string, unknown> = {
      provider: "opencode",
      concurrency: 1,
      issueSource: "github",
      org: "",
      project: "",
      serverUrl: "",
    };
    const config: DispatchConfig = {
      concurrency: 3,
      source: "azdevops",
      org: "myorg",
      project: "myproject",
      serverUrl: "http://localhost",
    };
    const explicitFlags = new Set<string>();
    applyMerge(args, config, explicitFlags);
    expect(args.concurrency).toBe(3);
    expect(args.issueSource).toBe("azdevops");
    expect(args.org).toBe("myorg");
    expect(args.project).toBe("myproject");
    expect(args.serverUrl).toBe("http://localhost");
  });

  it("partially explicit flags still allow config for other fields", () => {
    const args: Record<string, unknown> = {
      provider: "opencode",
      concurrency: 1,
    };
    const config: DispatchConfig = {
      provider: "copilot",
      concurrency: 8,
    };
    const explicitFlags = new Set<string>(["provider"]);
    applyMerge(args, config, explicitFlags);
    expect(args.provider).toBe("opencode");
    expect(args.concurrency).toBe(8);
  });
});

// ─── handleConfigCommand ─────────────────────────────────────────────

describe("handleConfigCommand", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
  });

  // Restore all mocks after the entire describe block
  afterEach(() => {
    // Note: we clear per-test and restore at suite teardown via vitest's auto-restore
  });

  it("set with missing key and value exits with error", async () => {
    await expect(handleConfigCommand(["set"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("set with invalid key exits with error", async () => {
    await expect(handleConfigCommand(["set", "invalidKey", "value"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("set with invalid provider value exits with error", async () => {
    await expect(handleConfigCommand(["set", "provider", "badprovider"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("set with invalid source value exits with error", async () => {
    await expect(handleConfigCommand(["set", "source", "jira"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("set with invalid concurrency exits with error", async () => {
    await expect(handleConfigCommand(["set", "concurrency", "abc"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("get with missing key exits with error", async () => {
    await expect(handleConfigCommand(["get"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("get with invalid key exits with error", async () => {
    await expect(handleConfigCommand(["get", "badkey"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("unknown operation exits with error", async () => {
    await expect(handleConfigCommand(["badop"])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("missing operation exits with error", async () => {
    await expect(handleConfigCommand([])).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("path prints the config file path", async () => {
    await handleConfigCommand(["path"]);
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const printed = mockConsoleLog.mock.calls[0][0] as string;
    expect(printed).toMatch(/\.dispatch\/config\.json$/);
  });
});
