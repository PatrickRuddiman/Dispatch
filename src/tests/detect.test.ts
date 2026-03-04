import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

import { checkProviderInstalled } from "../providers/detect.js";

const realPlatform = process.platform;

beforeEach(() => {
  mockExecFile.mockReset();
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

describe("checkProviderInstalled", () => {
  it("returns true when the binary is found", async () => {
    mockExecFile.mockResolvedValue({ stdout: "1.0.0\n" });

    const result = await checkProviderInstalled("claude");

    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith("claude", ["--version"], {
      shell: process.platform === "win32",
    });
  });

  it("returns false when exec rejects", async () => {
    mockExecFile.mockRejectedValue(new Error("spawn claude ENOENT"));

    const result = await checkProviderInstalled("claude");

    expect(result).toBe(false);
  });

  it("passes { shell: true } in the options argument when process.platform is 'win32'", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    mockExecFile.mockResolvedValue({ stdout: "1.0.0\n" });

    await checkProviderInstalled("claude");

    expect(mockExecFile).toHaveBeenCalledWith("claude", ["--version"], { shell: true });
  });

  it("does not pass shell: true when platform is not 'win32'", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    mockExecFile.mockResolvedValue({ stdout: "1.0.0\n" });

    await checkProviderInstalled("copilot");

    expect(mockExecFile).toHaveBeenCalledWith("copilot", ["--version"], { shell: false });
  });
});
