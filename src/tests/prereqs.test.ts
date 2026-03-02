import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

import { checkPrereqs } from "../helpers/prereqs.js";

const realNodeVersion = process.versions.node;

beforeEach(() => {
  mockExecFile.mockReset();
  Object.defineProperty(process.versions, "node", {
    value: realNodeVersion,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.versions, "node", {
    value: realNodeVersion,
    configurable: true,
  });
});

describe("checkPrereqs", () => {
  it("returns empty array when all prerequisites pass", async () => {
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });

    const failures = await checkPrereqs();

    expect(failures).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledWith("git", ["--version"]);
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
});
