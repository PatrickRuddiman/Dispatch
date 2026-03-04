/**
 * Test runner utility — detects the project's test command from package.json
 * and executes it as a child process, returning structured results.
 *
 * This module is standalone and testable without AI provider involvement.
 * It is used by the fix-tests pipeline to run the test suite and capture
 * failure output for AI-assisted fixing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { log } from "./helpers/logger.js";
import { withTimeout, TimeoutError } from "./helpers/timeout.js";

// ── Types ───────────────────────────────────────────────────────────

/** Structured result from running the project's test suite. */
export interface TestRunResult {
  /** Exit code of the test process (0 = all passed, non-zero = failures). */
  exitCode: number;
  /** Captured stdout from the test process. */
  stdout: string;
  /** Captured stderr from the test process. */
  stderr: string;
  /** The full command that was executed (e.g., "npm test"). */
  command: string;
}

// ── Detect Test Command ─────────────────────────────────────────────

/**
 * Reads package.json from the given directory and returns the test command.
 * Throws if package.json is missing or no test script is defined.
 */
export async function detectTestCommand(cwd: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "package.json"), "utf-8");
  } catch {
    throw new Error(`No package.json found in ${cwd}`);
  }

  const pkg = JSON.parse(raw);
  if (!pkg.scripts?.test) {
    throw new Error("No test script defined in package.json");
  }

  log.debug(`Detected test script: ${pkg.scripts.test}`);
  return "npm test";
}

// ── Run Tests ───────────────────────────────────────────────────────

/**
 * Runs the project's test suite by spawning the detected test command
 * as a child process. Returns a structured result with exit code,
 * stdout, stderr, and the command that was run.
 *
 * A non-zero exit code is an expected outcome (test failures) and does
 * NOT cause a rejection. Only spawn-level errors (e.g., missing npm)
 * will reject the returned promise.
 */
export async function runTests(cwd: string, timeoutMs = 300_000): Promise<TestRunResult> {
  const command = await detectTestCommand(cwd);

  log.debug(`Running test command: ${command} in ${cwd}`);

  const child = spawn("npm", ["test"], { cwd, shell: false });

  const spawnPromise = new Promise<TestRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Test runner spawn error: ${err.message}`, { cause: err }));
    });

    child.on("close", (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        command,
      });
    });
  });

  try {
    return await withTimeout(spawnPromise, timeoutMs, "test runner");
  } catch (err) {
    if (err instanceof TimeoutError) {
      child.kill();
    }
    throw err;
  }
}
