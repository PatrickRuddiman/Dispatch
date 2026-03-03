import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  validateConfigValue,
  CONFIG_KEYS,
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
    const config = { provider: "copilot", model: "gpt-4o" };
    await writeFile(join(tmpDir, "config.json"), JSON.stringify(config), "utf-8");
    const result = await loadConfig(tmpDir);
    expect(result).toEqual({ provider: "copilot", model: "gpt-4o" });
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
      source: "azdevops",
      model: "claude-sonnet-4-5",
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
      source: "github",
      model: "gpt-4o",
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
    await saveConfig({ provider: "opencode", model: "some-model" }, tmpDir);
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

  it("defaults to {CWD}/.dispatch/config.json when no override", () => {
    const result = getConfigPath();
    expect(result).toContain(process.cwd());
    expect(result).toBe(join(process.cwd(), ".dispatch", "config.json"));
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
});

// ─── Merge precedence (CLI > config > default) ─────────────────────

describe("merge precedence", () => {
  /**
   * Mapping from config keys to their corresponding CLI args field names.
   * This mirrors the merge logic in main() in src/cli.ts.
   */
  const CONFIG_TO_CLI: Record<string, string> = {
    provider: "provider",
    model: "model",
    source: "issueSource",
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
      model: "",
      issueSource: "github",
    };
    const config: DispatchConfig = {
      model: "claude-sonnet-4-5",
      source: "azdevops",
    };
    const explicitFlags = new Set<string>();
    applyMerge(args, config, explicitFlags);
    expect(args.model).toBe("claude-sonnet-4-5");
    expect(args.issueSource).toBe("azdevops");
  });

  it("partially explicit flags still allow config for other fields", () => {
    const args: Record<string, unknown> = {
      provider: "opencode",
      model: "",
    };
    const config: DispatchConfig = {
      provider: "copilot",
      model: "gpt-4o",
    };
    const explicitFlags = new Set<string>(["provider"]);
    applyMerge(args, config, explicitFlags);
    expect(args.provider).toBe("opencode");
    expect(args.model).toBe("gpt-4o");
  });
});
