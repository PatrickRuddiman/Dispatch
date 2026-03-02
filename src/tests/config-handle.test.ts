import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock fs to control handleConfigCommand's I/O without touching real files
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockRm = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

vi.mock("../config-prompts.js", () => ({
  runInteractiveConfigWizard: vi.fn().mockResolvedValue(undefined),
}));

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

import { handleConfigCommand } from "../config.js";
import { log } from "../helpers/logger.js";

describe("handleConfigCommand happy paths", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // default: no config file
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
  });

  // ── set (happy path) ──────────────────────────────────────────

  it("set saves valid provider value", async () => {
    await handleConfigCommand(["set", "provider", "copilot"]);

    expect(mockWriteFile).toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Set provider"));
  });

  it("set merges with existing config", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ concurrency: 4 }));

    await handleConfigCommand(["set", "provider", "copilot"]);

    const writeCall = mockWriteFile.mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written.provider).toBe("copilot");
    expect(written.concurrency).toBe(4);
  });

  // ── get ────────────────────────────────────────────────────────

  it("get prints existing value", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ provider: "copilot" }));

    await handleConfigCommand(["get", "provider"]);

    expect(mockConsoleLog).toHaveBeenCalledWith("copilot");
  });

  it("get prints nothing when key has no value", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({}));

    await handleConfigCommand(["get", "provider"]);

    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  // ── list ───────────────────────────────────────────────────────

  it("list prints all entries", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ provider: "copilot", concurrency: 3 }));

    await handleConfigCommand(["list"]);

    expect(mockConsoleLog).toHaveBeenCalledWith("provider=copilot");
    expect(mockConsoleLog).toHaveBeenCalledWith("concurrency=3");
  });

  it("list shows message when config is empty", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await handleConfigCommand(["list"]);

    expect(log.dim).toHaveBeenCalledWith("No configuration set.");
  });

  // ── reset ──────────────────────────────────────────────────────

  it("reset removes config file", async () => {
    await handleConfigCommand(["reset"]);

    expect(mockRm).toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledWith("Configuration reset.");
  });

  it("reset succeeds even if rm fails", async () => {
    mockRm.mockRejectedValue(new Error("ENOENT"));

    await handleConfigCommand(["reset"]);

    expect(log.success).toHaveBeenCalledWith("Configuration reset.");
  });
});
