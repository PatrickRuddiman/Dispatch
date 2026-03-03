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

  it("accepts non-empty string for org, project, workItemType, serverUrl", () => {
    for (const key of ["org", "project", "workItemType", "serverUrl"] as const) {
      expect(validateConfigValue(key, "some-value")).toBe(null);
    }
  });

  it("rejects empty string for org, project, workItemType, serverUrl", () => {
    for (const key of ["org", "project", "workItemType", "serverUrl"] as const) {
      const result = validateConfigValue(key, "");
      expect(result).not.toBe(null);
      expect(result).toContain("must not be empty");
    }
  });

  it("rejects whitespace-only for org, project, workItemType, serverUrl", () => {
    for (const key of ["org", "project", "workItemType", "serverUrl"] as const) {
      const result = validateConfigValue(key, "   ");
      expect(result).not.toBe(null);
      expect(result).toContain("must not be empty");
    }
  });

  it("accepts valid planTimeout (positive number)", () => {
    expect(validateConfigValue("planTimeout", "1")).toBe(null);
    expect(validateConfigValue("planTimeout", "10")).toBe(null);
    expect(validateConfigValue("planTimeout", "1.5")).toBe(null);
    expect(validateConfigValue("planTimeout", "0.5")).toBe(null);
  });

  it("rejects non-positive planTimeout", () => {
    const zero = validateConfigValue("planTimeout", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("positive number");

    const negative = validateConfigValue("planTimeout", "-5");
    expect(negative).not.toBe(null);
    expect(negative).toContain("positive number");
  });

  it("rejects non-numeric planTimeout", () => {
    const text = validateConfigValue("planTimeout", "abc");
    expect(text).not.toBe(null);
    expect(text).toContain("positive number");

    const empty = validateConfigValue("planTimeout", "");
    expect(empty).not.toBe(null);
  });

  it("accepts valid retries (non-negative integer)", () => {
    expect(validateConfigValue("retries", "0")).toBe(null);
    expect(validateConfigValue("retries", "1")).toBe(null);
    expect(validateConfigValue("retries", "5")).toBe(null);
  });

  it("rejects negative retries", () => {
    const negative = validateConfigValue("retries", "-1");
    expect(negative).not.toBe(null);
    expect(negative).toContain("non-negative integer");
  });

  it("rejects non-integer retries", () => {
    const decimal = validateConfigValue("retries", "1.5");
    expect(decimal).not.toBe(null);
    expect(decimal).toContain("non-negative integer");

    const text = validateConfigValue("retries", "abc");
    expect(text).not.toBe(null);
    expect(text).toContain("non-negative integer");
  });

  it("accepts valid planRetries (non-negative integer)", () => {
    expect(validateConfigValue("planRetries", "0")).toBe(null);
    expect(validateConfigValue("planRetries", "1")).toBe(null);
    expect(validateConfigValue("planRetries", "5")).toBe(null);
  });

  it("rejects negative planRetries", () => {
    const negative = validateConfigValue("planRetries", "-1");
    expect(negative).not.toBe(null);
    expect(negative).toContain("non-negative integer");
  });

  it("rejects non-integer planRetries", () => {
    const decimal = validateConfigValue("planRetries", "1.5");
    expect(decimal).not.toBe(null);
    expect(decimal).toContain("non-negative integer");

    const text = validateConfigValue("planRetries", "abc");
    expect(text).not.toBe(null);
    expect(text).toContain("non-negative integer");
  });

  it("accepts valid testTimeout (positive number)", () => {
    expect(validateConfigValue("testTimeout", "1")).toBe(null);
    expect(validateConfigValue("testTimeout", "10")).toBe(null);
    expect(validateConfigValue("testTimeout", "1.5")).toBe(null);
    expect(validateConfigValue("testTimeout", "0.5")).toBe(null);
  });

  it("rejects non-positive testTimeout", () => {
    const zero = validateConfigValue("testTimeout", "0");
    expect(zero).not.toBe(null);
    expect(zero).toContain("positive number");

    const negative = validateConfigValue("testTimeout", "-5");
    expect(negative).not.toBe(null);
    expect(negative).toContain("positive number");
  });

  it("rejects non-numeric testTimeout", () => {
    const text = validateConfigValue("testTimeout", "abc");
    expect(text).not.toBe(null);
    expect(text).toContain("positive number");

    const empty = validateConfigValue("testTimeout", "");
    expect(empty).not.toBe(null);
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
