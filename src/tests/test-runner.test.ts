import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

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
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { detectTestCommand, runTests } from "../test-runner.js";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function createMockChildProcess() {
  const child = new EventEmitter();
  (child as any).stdout = new EventEmitter();
  (child as any).stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── detectTestCommand ───────────────────────────────────────────────

describe("detectTestCommand", () => {
  it("returns 'npm test' when package.json has a test script", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const result = await detectTestCommand("/some/dir");

    expect(result).toBe("npm test");
    expect(readFile).toHaveBeenCalledWith("/some/dir/package.json", "utf-8");
  });

  it("throws when package.json does not exist", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    await expect(detectTestCommand("/missing")).rejects.toThrow(
      "No package.json found in /missing",
    );
  });

  it("throws when scripts.test is not defined", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: {} }),
    );

    await expect(detectTestCommand("/no-test")).rejects.toThrow(
      "No test script defined in package.json",
    );
  });

  it("throws when scripts key is missing entirely", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ name: "my-pkg" }),
    );

    await expect(detectTestCommand("/no-scripts")).rejects.toThrow(
      "No test script defined in package.json",
    );
  });

  it("throws when test script is an empty string", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "" } }),
    );

    await expect(detectTestCommand("/empty-test")).rejects.toThrow(
      "No test script defined in package.json",
    );
  });
});

// ── runTests ────────────────────────────────────────────────────────

describe("runTests", () => {
  it("returns structured result for passing tests (exit code 0)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        (child as any).stdout.emit("data", "all tests passed\n");
        child.emit("close", 0);
      });
      return child;
    }) as any);

    const result = await runTests("/project");

    expect(result).toEqual({
      exitCode: 0,
      stdout: "all tests passed\n",
      stderr: "",
      command: "npm test",
    });
  });

  it("returns structured result for failing tests (non-zero exit code)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        (child as any).stderr.emit("data", "FAIL src/test.ts\n");
        child.emit("close", 1);
      });
      return child;
    }) as any);

    const result = await runTests("/project");

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "FAIL src/test.ts\n",
      command: "npm test",
    });
  });

  it("defaults exit code to 1 when code is null", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        child.emit("close", null);
      });
      return child;
    }) as any);

    const result = await runTests("/project");

    expect(result.exitCode).toBe(1);
  });

  it("rejects when spawn emits an error event", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const spawnError = new Error("spawn ENOENT");
    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        child.emit("error", spawnError);
      });
      return child;
    }) as any);

    const err = await runTests("/project").catch((err: Error) => err);

    expect(err.message).toContain("spawn ENOENT");
    expect(err.cause).toBe(spawnError);
  });

  it("preserves spawn error properties via cause", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const spawnError = Object.assign(new Error("spawn npm ENOENT"), {
      code: "ENOENT",
      syscall: "spawn npm",
    });
    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        child.emit("error", spawnError);
      });
      return child;
    }) as any);

    const err = await runTests("/project").catch((err: Error) => err);

    expect(err.message).toContain("spawn npm ENOENT");
    expect(err.cause).toBe(spawnError);
    expect((err.cause as any).code).toBe("ENOENT");
    expect((err.cause as any).syscall).toBe("spawn npm");
  });

  it("concatenates multiple stdout chunks", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        (child as any).stdout.emit("data", "chunk1");
        (child as any).stdout.emit("data", "chunk2");
        (child as any).stdout.emit("data", "chunk3");
        child.emit("close", 0);
      });
      return child;
    }) as any);

    const result = await runTests("/project");

    expect(result.stdout).toBe("chunk1chunk2chunk3");
  });

  it("calls spawn with correct arguments", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    const child = createMockChildProcess();
    vi.mocked(spawn).mockImplementation((() => {
      process.nextTick(() => {
        child.emit("close", 0);
      });
      return child;
    }) as any);

    await runTests("/project");

    expect(spawn).toHaveBeenCalledWith("npm", ["test"], {
      cwd: "/project",
      shell: true,
    });
  });
});
