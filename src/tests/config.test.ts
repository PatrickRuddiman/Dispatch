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
  CONFIG_BOUNDS,
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

  it("round-trips config with all Azure DevOps fields", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const config: DispatchConfig = {
      provider: "copilot",
      model: "gpt-4o",
      source: "azdevops",
      org: "https://dev.azure.com/myorg",
      project: "MyProject",
      workItemType: "User Story",
      iteration: "MyProject\\Sprint 1",
      area: "MyProject\\Team A",
    };
    await saveConfig(config, tmpDir);
    const loaded = await loadConfig(tmpDir);
    expect(loaded).toEqual(config);
  });
});

// ─── getConfigPath ───────────────────────────────────────────────────

describe("getConfigPath", () => {
  it("returns path under the given directory", () => {
    expect(getConfigPath("/custom/dir")).toBe(join("/custom/dir", "config.json"));
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

  it("accepts valid testTimeout (within bounds)", () => {
    expect(validateConfigValue("testTimeout", String(CONFIG_BOUNDS.testTimeout.min))).toBe(null);
    expect(validateConfigValue("testTimeout", "10")).toBe(null);
    expect(validateConfigValue("testTimeout", "1.5")).toBe(null);
    expect(validateConfigValue("testTimeout", String(CONFIG_BOUNDS.testTimeout.max))).toBe(null);
  });

  it("rejects testTimeout below minimum", () => {
    const zero = validateConfigValue("testTimeout", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("between");

    const negative = validateConfigValue("testTimeout", "-5");
    expect(negative).not.toBe(null);
    expect(negative).toContain("between");
  });

  it("rejects testTimeout above maximum", () => {
    const result = validateConfigValue("testTimeout", String(CONFIG_BOUNDS.testTimeout.max + 1));
    expect(result).not.toBe(null);
    expect(result).toContain("between");
  });

  it("rejects non-numeric testTimeout", () => {
    const text = validateConfigValue("testTimeout", "abc");
    expect(text).not.toBe(null);
    expect(text).toContain("between");

    const empty = validateConfigValue("testTimeout", "");
    expect(empty).not.toBe(null);
  });

  it("rejects Infinity and NaN for testTimeout", () => {
    expect(validateConfigValue("testTimeout", "Infinity")).not.toBe(null);
    expect(validateConfigValue("testTimeout", "NaN")).not.toBe(null);
  });

  it("accepts valid planTimeout (within bounds)", () => {
    expect(validateConfigValue("planTimeout", String(CONFIG_BOUNDS.planTimeout.min))).toBe(null);
    expect(validateConfigValue("planTimeout", "10")).toBe(null);
    expect(validateConfigValue("planTimeout", "1.5")).toBe(null);
    expect(validateConfigValue("planTimeout", String(CONFIG_BOUNDS.planTimeout.max))).toBe(null);
  });

  it("rejects planTimeout below minimum", () => {
    const zero = validateConfigValue("planTimeout", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("between");

    const negative = validateConfigValue("planTimeout", "-1");
    expect(negative).not.toBe(null);
  });

  it("rejects planTimeout above maximum", () => {
    const result = validateConfigValue("planTimeout", String(CONFIG_BOUNDS.planTimeout.max + 1));
    expect(result).not.toBe(null);
    expect(result).toContain("between");
  });

  it("rejects non-numeric planTimeout", () => {
    expect(validateConfigValue("planTimeout", "abc")).not.toBe(null);
    expect(validateConfigValue("planTimeout", "")).not.toBe(null);
  });

  it("rejects Infinity and NaN for planTimeout", () => {
    expect(validateConfigValue("planTimeout", "Infinity")).not.toBe(null);
    expect(validateConfigValue("planTimeout", "NaN")).not.toBe(null);
  });

  it("accepts valid specTimeout (within bounds)", () => {
    expect(validateConfigValue("specTimeout", String(CONFIG_BOUNDS.specTimeout.min))).toBe(null);
    expect(validateConfigValue("specTimeout", "10")).toBe(null);
    expect(validateConfigValue("specTimeout", "1.5")).toBe(null);
    expect(validateConfigValue("specTimeout", String(CONFIG_BOUNDS.specTimeout.max))).toBe(null);
  });

  it("rejects specTimeout below minimum", () => {
    const zero = validateConfigValue("specTimeout", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("between");

    const negative = validateConfigValue("specTimeout", "-1");
    expect(negative).not.toBe(null);
  });

  it("rejects specTimeout above maximum", () => {
    const result = validateConfigValue("specTimeout", String(CONFIG_BOUNDS.specTimeout.max + 1));
    expect(result).not.toBe(null);
    expect(result).toContain("between");
  });

  it("rejects non-numeric specTimeout", () => {
    expect(validateConfigValue("specTimeout", "abc")).not.toBe(null);
    expect(validateConfigValue("specTimeout", "")).not.toBe(null);
  });

  it("rejects Infinity and NaN for specTimeout", () => {
    expect(validateConfigValue("specTimeout", "Infinity")).not.toBe(null);
    expect(validateConfigValue("specTimeout", "NaN")).not.toBe(null);
  });

  it("accepts valid concurrency (within bounds)", () => {
    expect(validateConfigValue("concurrency", String(CONFIG_BOUNDS.concurrency.min))).toBe(null);
    expect(validateConfigValue("concurrency", "4")).toBe(null);
    expect(validateConfigValue("concurrency", String(CONFIG_BOUNDS.concurrency.max))).toBe(null);
  });

  it("rejects concurrency below minimum", () => {
    const zero = validateConfigValue("concurrency", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("between");

    const negative = validateConfigValue("concurrency", "-1");
    expect(negative).not.toBe(null);
  });

  it("rejects concurrency above maximum", () => {
    const result = validateConfigValue("concurrency", String(CONFIG_BOUNDS.concurrency.max + 1));
    expect(result).not.toBe(null);
    expect(result).toContain("between");
  });

  it("rejects non-integer concurrency", () => {
    expect(validateConfigValue("concurrency", "1.5")).not.toBe(null);
    expect(validateConfigValue("concurrency", "abc")).not.toBe(null);
    expect(validateConfigValue("concurrency", "")).not.toBe(null);
  });

  it("rejects Infinity and NaN for concurrency", () => {
    expect(validateConfigValue("concurrency", "Infinity")).not.toBe(null);
    expect(validateConfigValue("concurrency", "NaN")).not.toBe(null);
  });

  it("accepts valid org values", () => {
    expect(validateConfigValue("org", "https://dev.azure.com/myorg")).toBe(null);
    expect(validateConfigValue("org", "my-org")).toBe(null);
  });

  it("rejects empty org", () => {
    expect(validateConfigValue("org", "")).not.toBe(null);
    expect(validateConfigValue("org", "   ")).not.toBe(null);
  });

  it("accepts valid project values", () => {
    expect(validateConfigValue("project", "MyProject")).toBe(null);
    expect(validateConfigValue("project", "my-project-123")).toBe(null);
  });

  it("rejects empty project", () => {
    expect(validateConfigValue("project", "")).not.toBe(null);
    expect(validateConfigValue("project", "   ")).not.toBe(null);
  });

  it("accepts valid workItemType values", () => {
    expect(validateConfigValue("workItemType", "User Story")).toBe(null);
    expect(validateConfigValue("workItemType", "Product Backlog Item")).toBe(null);
    expect(validateConfigValue("workItemType", "Bug")).toBe(null);
  });

  it("rejects empty workItemType", () => {
    expect(validateConfigValue("workItemType", "")).not.toBe(null);
    expect(validateConfigValue("workItemType", "   ")).not.toBe(null);
  });

  it("accepts valid iteration values", () => {
    expect(validateConfigValue("iteration", "MyProject\\Sprint 1")).toBe(null);
    expect(validateConfigValue("iteration", "@CurrentIteration")).toBe(null);
  });

  it("rejects empty iteration", () => {
    expect(validateConfigValue("iteration", "")).not.toBe(null);
    expect(validateConfigValue("iteration", "   ")).not.toBe(null);
  });

  it("accepts valid area values", () => {
    expect(validateConfigValue("area", "MyProject\\Team A")).toBe(null);
    expect(validateConfigValue("area", "RootArea")).toBe(null);
  });

  it("rejects empty area", () => {
    expect(validateConfigValue("area", "")).not.toBe(null);
    expect(validateConfigValue("area", "   ")).not.toBe(null);
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
    specTimeout: "specTimeout",
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
      specTimeout: undefined,
    };
    const config: DispatchConfig = {
      model: "claude-sonnet-4-5",
      source: "azdevops",
      specTimeout: 12,
    };
    const explicitFlags = new Set<string>();
    applyMerge(args, config, explicitFlags);
    expect(args.model).toBe("claude-sonnet-4-5");
    expect(args.issueSource).toBe("azdevops");
    expect(args.specTimeout).toBe(12);
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
