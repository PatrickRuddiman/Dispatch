import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

import { checkPrereqs } from "../helpers/prereqs.js";

const realNodeVersion = process.versions.node;
const realPlatform = process.platform;

beforeEach(() => {
  mockExecFile.mockReset();
  Object.defineProperty(process.versions, "node", {
    value: realNodeVersion,
    configurable: true,
  });
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.versions, "node", {
    value: realNodeVersion,
    configurable: true,
  });
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

describe("checkPrereqs", () => {
  it("returns empty array when all prerequisites pass", async () => {
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });

    const failures = await checkPrereqs();

    expect(failures).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledWith("git", ["--version"], { shell: realPlatform === "win32" });
  });

  it("reports failure when git is not found", async () => {
    mockExecFile.mockRejectedValue(new Error("spawn git ENOENT"));

    const failures = await checkPrereqs();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/git/i);
    expect(failures[0]).toMatch(/not found/i);
  });

  it("reports failure when Node.js version is below minimum", async () => {
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });
    Object.defineProperty(process.versions, "node", {
      value: "18.0.0",
      configurable: true,
    });

    const failures = await checkPrereqs();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/Node\.js/);
    expect(failures[0]).toMatch(/20\.12\.0/);
    expect(failures[0]).toMatch(/18\.0\.0/);
  });

  it("reports multiple failures when git is missing and Node.js is too old", async () => {
    mockExecFile.mockRejectedValue(new Error("spawn git ENOENT"));
    Object.defineProperty(process.versions, "node", {
      value: "18.0.0",
      configurable: true,
    });

    const failures = await checkPrereqs();

    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/git/i);
    expect(failures[1]).toMatch(/Node\.js/);
  });

  it("passes shell option to git exec on Windows", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });

    await checkPrereqs();

    expect(mockExecFile).toHaveBeenCalledWith("git", ["--version"], { shell: true });
  });

  it("omits shell option for git exec on non-Windows", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });

    await checkPrereqs();

    expect(mockExecFile).toHaveBeenCalledWith("git", ["--version"], { shell: false });
  });

  it("passes when Node.js major matches minimum and minor is higher", async () => {
    // Same major (20), minor higher (20 > 12), should pass
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });
    Object.defineProperty(process.versions, "node", {
      value: "20.20.0",
      configurable: true,
    });

    const failures = await checkPrereqs();

    expect(failures).toEqual([]);
  });

  it("passes when Node.js major and minor match minimum but patch is higher", async () => {
    // Same major (20), same minor (12), patch higher (5 >= 0)
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });
    Object.defineProperty(process.versions, "node", {
      value: "20.12.5",
      configurable: true,
    });

    const failures = await checkPrereqs();

    expect(failures).toEqual([]);
  });

  it("fails when Node.js major matches but minor is below minimum", async () => {
    // Same major (20), minor lower (11 < 12)
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });
    Object.defineProperty(process.versions, "node", {
      value: "20.11.0",
      configurable: true,
    });

    const failures = await checkPrereqs();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/Node\.js/);
  });

  it("passes for exact minimum version", async () => {
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });
    Object.defineProperty(process.versions, "node", {
      value: "20.12.0",
      configurable: true,
    });

    const failures = await checkPrereqs();

    expect(failures).toEqual([]);
  });
});
