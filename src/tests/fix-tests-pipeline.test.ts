import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock references
const { mocks } = vi.hoisted(() => {
  const mockCreateSession = vi.fn().mockResolvedValue("sess-1");
  const mockPrompt = vi.fn().mockResolvedValue("Tests fixed.");
  const mockCleanup = vi.fn().mockResolvedValue(undefined);
  return {
    mocks: { mockCreateSession, mockPrompt, mockCleanup },
  };
});

vi.mock("../helpers/logger.js", () => ({
  log: {
    verbose: false,
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    task: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
    formatErrorChain: vi.fn((e: unknown) => String(e)),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("../providers/index.js", () => ({
  bootProvider: vi.fn().mockResolvedValue({
    name: "mock",
    model: "mock-model",
    createSession: mocks.mockCreateSession,
    prompt: mocks.mockPrompt,
    cleanup: mocks.mockCleanup,
  }),
}));

vi.mock("../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import {
  detectTestCommand,
  runTestCommand,
  buildFixTestsPrompt,
  runFixTestsPipeline,
  type FixTestsPipelineOptions,
  type TestRunResult,
} from "../orchestrator/fix-tests-pipeline.js";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { log } from "../helpers/logger.js";
import { bootProvider } from "../providers/index.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { createMockProvider } from "./fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-setup default mock returns cleared by clearAllMocks
  mocks.mockCreateSession.mockResolvedValue("sess-1");
  mocks.mockPrompt.mockResolvedValue("Tests fixed.");
  mocks.mockCleanup.mockResolvedValue(undefined);
  vi.mocked(bootProvider).mockResolvedValue(
    createMockProvider({
      createSession: mocks.mockCreateSession,
      prompt: mocks.mockPrompt,
      cleanup: mocks.mockCleanup,
    }),
  );
});

function baseOpts(
  overrides?: Partial<FixTestsPipelineOptions>,
): FixTestsPipelineOptions {
  return { cwd: "/project", provider: "opencode", verbose: false, ...overrides };
}

const validPackageJson = JSON.stringify({ scripts: { test: "vitest run" } });

describe("detectTestCommand", () => {
  it("returns 'npm test' when package.json has a valid test script", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    const result = await detectTestCommand("/dir");
    expect(result).toBe("npm test");
  });

  it("returns null when package.json is missing", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const result = await detectTestCommand("/dir");
    expect(result).toBeNull();
  });

  it("returns null when no test script is defined", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ scripts: {} }));
    const result = await detectTestCommand("/dir");
    expect(result).toBeNull();
  });

  it("returns null when test script is the npm default placeholder", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    );
    const result = await detectTestCommand("/dir");
    expect(result).toBeNull();
  });

  it("returns null and logs debug when package.json contains malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("this is not json");
    const result = await detectTestCommand("/dir");
    expect(result).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse package.json"),
    );
  });
});

describe("runTestCommand", () => {
  it("resolves with exit code 0 for passing tests", async () => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(null, "all passed\n", "");
    }) as any);
    const result = await runTestCommand("npm test", "/dir");
    expect(result).toEqual({
      exitCode: 0,
      stdout: "all passed\n",
      stderr: "",
      command: "npm test",
    });
  });

  it("resolves with non-zero exit code for failing tests", async () => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "FAIL\n");
    }) as any);
    const result = await runTestCommand("npm test", "/dir");
    expect(result.exitCode).toBe(1);
  });

  it("defaults exit code to 1 when error has no code property", async () => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(new Error("signal"), "", "");
    }) as any);
    const result = await runTestCommand("npm test", "/dir");
    expect(result.exitCode).toBe(1);
  });
});

describe("buildFixTestsPrompt", () => {
  const fixture: TestRunResult = {
    exitCode: 1,
    stdout: "PASS a\nFAIL b",
    stderr: "Error in b",
    command: "npm test",
  };

  it("includes test command, exit code, and output in the prompt", () => {
    const prompt = buildFixTestsPrompt(fixture, "/project");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("1");
    expect(prompt).toContain("FAIL b");
    expect(prompt).toContain("Error in b");
    expect(prompt).toContain("/project");
  });

  it("includes fix instructions in the prompt", () => {
    const prompt = buildFixTestsPrompt(fixture, "/project");
    expect(prompt).toContain("minimal fixes");
    expect(prompt).toContain("Do NOT commit");
  });
});

describe("runFixTestsPipeline", () => {
  it("returns success false when no test command is detected", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const result = await runFixTestsPipeline(baseOpts());
    expect(result).toEqual({
      mode: "fix-tests",
      success: false,
      error: "No test command found",
    });
    expect(log.error).toHaveBeenCalled();
  });

  it("returns early in dry-run mode without running tests", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    const result = await runFixTestsPipeline(baseOpts({ dryRun: true }));
    expect(result.mode).toBe("fix-tests");
    expect(result.success).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Dry run"),
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns success true when tests already pass", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(null, "all passed", "");
    }) as any);
    const result = await runFixTestsPipeline(baseOpts());
    expect(result).toEqual({ mode: "fix-tests", success: true });
    expect(bootProvider).not.toHaveBeenCalled();
  });

  it("dispatches to AI and re-runs tests on failure", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    let callCount = 0;
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      callCount++;
      if (callCount === 1) {
        cb(Object.assign(new Error("fail"), { code: 1 }), "", "FAIL output");
      } else {
        cb(null, "all passed", "");
      }
    }) as any);
    const result = await runFixTestsPipeline(baseOpts());
    expect(result).toEqual({ mode: "fix-tests", success: true });
    expect(bootProvider).toHaveBeenCalled();
    expect(mocks.mockCreateSession).toHaveBeenCalled();
    expect(mocks.mockPrompt).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("FAIL output"),
    );
    expect(mocks.mockCleanup).toHaveBeenCalled();
  });

  it("returns success false when AI returns null response", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(Object.assign(new Error("fail"), { code: 1 }), "", "FAIL");
    }) as any);
    mocks.mockPrompt.mockResolvedValue(null);
    const result = await runFixTestsPipeline(baseOpts());
    expect(result).toEqual({
      mode: "fix-tests",
      success: false,
      error: "No response from agent",
    });
  });

  it("returns success false when tests still fail after fix attempt", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(Object.assign(new Error("fail"), { code: 1 }), "", "FAIL");
    }) as any);
    const result = await runFixTestsPipeline(baseOpts());
    expect(result).toEqual({
      mode: "fix-tests",
      success: false,
      error: "Tests still failing after fix attempt",
    });
  });

  it("registers cleanup for the provider", async () => {
    vi.mocked(readFile).mockResolvedValue(validPackageJson);
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: Function,
    ) => {
      cb(Object.assign(new Error("fail"), { code: 1 }), "", "FAIL");
    }) as any);
    await runFixTestsPipeline(baseOpts());
    expect(registerCleanup).toHaveBeenCalled();
  });
});
