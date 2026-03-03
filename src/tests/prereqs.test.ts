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

  it("reports failure when gh CLI is not found and datasource is github", async () => {
    mockExecFile.mockImplementation((cmd: string) => {
      if (cmd === "git") return Promise.resolve({ stdout: "git version 2.43.0\n" });
      if (cmd === "gh") return Promise.reject(new Error("spawn gh ENOENT"));
      return Promise.resolve({ stdout: "" });
    });

    const failures = await checkPrereqs({ datasource: "github" });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/gh/i);
    expect(failures[0]).toMatch(/not found/i);
  });

  it("reports failure when az CLI is not found and datasource is azdevops", async () => {
    mockExecFile.mockImplementation((cmd: string) => {
      if (cmd === "git") return Promise.resolve({ stdout: "git version 2.43.0\n" });
      if (cmd === "az") return Promise.reject(new Error("spawn az ENOENT"));
      return Promise.resolve({ stdout: "" });
    });

    const failures = await checkPrereqs({ datasource: "azdevops" });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/az/i);
    expect(failures[0]).toMatch(/not found/i);
  });

  it("does not check gh or az when datasource is md", async () => {
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });

    const failures = await checkPrereqs({ datasource: "md" });

    expect(failures).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledWith("git", ["--version"]);
    expect(mockExecFile).not.toHaveBeenCalledWith("gh", expect.anything());
    expect(mockExecFile).not.toHaveBeenCalledWith("az", expect.anything());
  });

  it("does not check gh or az when no context is provided", async () => {
    mockExecFile.mockResolvedValue({ stdout: "git version 2.43.0\n" });

    const failures = await checkPrereqs();

    expect(failures).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledWith("git", ["--version"]);
    expect(mockExecFile).not.toHaveBeenCalledWith("gh", expect.anything());
    expect(mockExecFile).not.toHaveBeenCalledWith("az", expect.anything());
  });

  it("reports multiple failures including datasource-specific CLI tool", async () => {
    mockExecFile.mockImplementation((cmd: string) => {
      if (cmd === "git") return Promise.reject(new Error("spawn git ENOENT"));
      if (cmd === "gh") return Promise.reject(new Error("spawn gh ENOENT"));
      return Promise.resolve({ stdout: "" });
    });
    Object.defineProperty(process.versions, "node", {
      value: "18.0.0",
      configurable: true,
    });

    const failures = await checkPrereqs({ datasource: "github" });

    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatch(/git/i);
    expect(failures[1]).toMatch(/Node\.js/);
    expect(failures[2]).toMatch(/gh/i);
  });

  it("passes all checks when gh is available and datasource is github", async () => {
    mockExecFile.mockImplementation((cmd: string) => {
      if (cmd === "git") return Promise.resolve({ stdout: "git version 2.43.0\n" });
      if (cmd === "gh") return Promise.resolve({ stdout: "gh version 2.50.0\n" });
      return Promise.resolve({ stdout: "" });
    });

    const failures = await checkPrereqs({ datasource: "github" });

    expect(failures).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledWith("gh", ["--version"]);
  });

  it("passes all checks when az is available and datasource is azdevops", async () => {
    mockExecFile.mockImplementation((cmd: string) => {
      if (cmd === "git") return Promise.resolve({ stdout: "git version 2.43.0\n" });
      if (cmd === "az") return Promise.resolve({ stdout: "azure-cli 2.60.0\n" });
      return Promise.resolve({ stdout: "" });
    });

    const failures = await checkPrereqs({ datasource: "azdevops" });

    expect(failures).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledWith("az", ["--version"]);
  });
});
