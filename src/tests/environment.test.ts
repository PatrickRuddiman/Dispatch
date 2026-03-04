import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getEnvironmentInfo, formatEnvironmentPrompt } from "../helpers/environment.js";

const realPlatform = process.platform;

beforeEach(() => {
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

describe("getEnvironmentInfo", () => {
  it("returns Windows info for win32", () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const info = getEnvironmentInfo();

    expect(info.platform).toBe("win32");
    expect(info.os).toBe("Windows");
    expect(info.shell).toBe("cmd.exe/PowerShell");
  });

  it("returns Linux info for linux", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    const info = getEnvironmentInfo();

    expect(info.platform).toBe("linux");
    expect(info.os).toBe("Linux");
    expect(info.shell).toBe("bash");
  });

  it("returns macOS info for darwin", () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    const info = getEnvironmentInfo();

    expect(info.platform).toBe("darwin");
    expect(info.os).toBe("macOS");
    expect(info.shell).toBe("zsh/bash");
  });
});

describe("formatEnvironmentPrompt", () => {
  it("includes Windows OS and shell for win32", () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const prompt = formatEnvironmentPrompt();

    expect(prompt).toContain("Windows");
    expect(prompt).toContain("cmd.exe/PowerShell");
    expect(prompt).toContain("run commands directly");
  });

  it("includes Linux OS and shell for linux", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    const prompt = formatEnvironmentPrompt();

    expect(prompt).toContain("Linux");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("run commands directly");
  });

  it("includes macOS OS and shell for darwin", () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    const prompt = formatEnvironmentPrompt();

    expect(prompt).toContain("macOS");
    expect(prompt).toContain("zsh/bash");
    expect(prompt).toContain("run commands directly");
  });
});
