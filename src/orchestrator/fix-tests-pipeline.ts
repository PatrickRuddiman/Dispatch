/**
 * Fix-tests pipeline — detects the project's test command, runs the test
 * suite, captures failure output, dispatches an AI agent to fix the broken
 * tests, and optionally re-runs tests to verify the fix.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import type { FixTestsSummary } from "./runner.js";
import type { ProviderName } from "../providers/interface.js";
import { bootProvider } from "../providers/index.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { log } from "../helpers/logger.js";
import { FileLogger, fileLoggerStorage } from "../helpers/file-logger.js";
import { formatEnvironmentPrompt } from "../helpers/environment.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FixTestsPipelineOptions {
  cwd: string;
  provider: string;
  serverUrl?: string;
  verbose: boolean;
  dryRun?: boolean;
  testTimeout?: number;
}

export interface TestRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
}

/* ------------------------------------------------------------------ */
/*  Test runner utilities                                               */
/* ------------------------------------------------------------------ */

/** Detect the test command from package.json in the given directory. */
export async function detectTestCommand(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    let pkg: any;
    try {
      pkg = JSON.parse(raw);
    } catch {
      log.debug(
        `Failed to parse package.json: ${raw.slice(0, 200)}`,
      );
      return null;
    }
    const testScript: unknown = pkg?.scripts?.test;
    if (
      typeof testScript === "string" &&
      testScript !== 'echo "Error: no test specified" && exit 1'
    ) {
      return "npm test";
    }
    return null;
  } catch {
    return null;
  }
}

/** Run a shell command and capture its output. Does NOT throw on non-zero exit. */
export function runTestCommand(
  command: string,
  cwd: string,
): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command.split(" ");
    execFileCb(
      cmd,
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error
            ? ((error as { code?: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout, stderr, command });
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Prompt builder                                                     */
/* ------------------------------------------------------------------ */

/** Build a focused AI prompt from test failure output. */
export function buildFixTestsPrompt(
  testResult: TestRunResult,
  cwd: string,
): string {
  const output = [testResult.stdout, testResult.stderr]
    .filter(Boolean)
    .join("\n");
  return [
    `You are fixing failing tests in a project.`,
    ``,
    `**Working directory:** ${cwd}`,
    `**Test command:** ${testResult.command}`,
    `**Exit code:** ${testResult.exitCode}`,
    ``,
    formatEnvironmentPrompt(),
    ``,
    `## Test Output`,
    ``,
    "```",
    output,
    "```",
    ``,
    `## Instructions`,
    ``,
    `- Read the failing test files and the source code they test.`,
    `- Understand why the tests are failing.`,
    `- Make minimal fixes — fix the tests or fix the source code, whichever is appropriate.`,
    `- Do NOT commit changes — the developer controls commits.`,
    `- Do NOT modify tests to simply skip or ignore failures.`,
    `- When finished, confirm by saying "Tests fixed."`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Main pipeline                                                      */
/* ------------------------------------------------------------------ */

/** Run the fix-tests pipeline end-to-end. */
export async function runFixTestsPipeline(
  opts: FixTestsPipelineOptions,
): Promise<FixTestsSummary> {
  const { cwd } = opts;
  const testTimeoutMs = (opts.testTimeout ?? 5) * 60_000;
  const start = Date.now();

  // Detect test command
  const testCommand = await detectTestCommand(cwd);
  if (!testCommand) {
    log.error(
      'No test command found. Ensure package.json has a "test" script.',
    );
    return { mode: "fix-tests", success: false, error: "No test command found" };
  }
  log.info(`Detected test command: ${testCommand}`);

  // Dry-run mode
  if (opts.dryRun) {
    log.info(`Dry run — would execute: ${testCommand}`);
    log.dim(`  Working directory: ${cwd}`);
    return { mode: "fix-tests", success: false };
  }

  const fileLogger = opts.verbose ? new FileLogger("fix-tests", cwd) : null;

  const pipelineBody = async (): Promise<FixTestsSummary> => {
    try {
      // Run the test suite
      log.info("Running test suite...");
      const testResult = await runTestCommand(testCommand, cwd);
      fileLoggerStorage.getStore()?.info(`Test run complete (exit code: ${testResult.exitCode})`);

      // Check if tests already pass
      if (testResult.exitCode === 0) {
        log.success("All tests pass — nothing to fix.");
        return { mode: "fix-tests", success: true };
      }
      log.warn(
        `Tests failed (exit code ${testResult.exitCode}). Dispatching AI to fix...`,
      );

      // Boot the provider
      const provider = (opts.provider ?? "opencode") as ProviderName;
      const instance = await bootProvider(provider, { url: opts.serverUrl, cwd });
      registerCleanup(() => instance.cleanup());

      // Build prompt and dispatch
      const prompt = buildFixTestsPrompt(testResult, cwd);
      log.debug(`Prompt built (${prompt.length} chars)`);
      fileLoggerStorage.getStore()?.prompt("fix-tests", prompt);
      const sessionId = await instance.createSession();
      const response = await instance.prompt(sessionId, prompt);

      if (response === null) {
        fileLoggerStorage.getStore()?.error("No response from AI agent.");
        log.error("No response from AI agent.");
        await instance.cleanup();
        return { mode: "fix-tests", success: false, error: "No response from agent" };
      }
      if (response) fileLoggerStorage.getStore()?.response("fix-tests", response);
      log.success("AI agent completed fixes.");

      // Re-run tests to verify
      fileLoggerStorage.getStore()?.phase("Verification");
      log.info("Re-running tests to verify fixes...");
      const verifyResult = await runTestCommand(testCommand, cwd);
      await instance.cleanup();
      fileLoggerStorage.getStore()?.info(`Verification result: exit code ${verifyResult.exitCode}`);

      if (verifyResult.exitCode === 0) {
        log.success("All tests pass after fixes!");
        return { mode: "fix-tests", success: true };
      }

      log.warn(
        `Tests still failing after fix attempt (exit code ${verifyResult.exitCode}).`,
      );
      return { mode: "fix-tests", success: false, error: "Tests still failing after fix attempt" };
    } catch (err) {
      const message = log.extractMessage(err);
      fileLoggerStorage.getStore()?.error(`Fix-tests pipeline failed: ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
      log.error(`Fix-tests pipeline failed: ${log.formatErrorChain(err)}`);
      return { mode: "fix-tests", success: false, error: message };
    }
  };

  if (fileLogger) {
    return fileLoggerStorage.run(fileLogger, async () => {
      try {
        return await pipelineBody();
      } finally {
        fileLogger.close();
      }
    });
  }
  return pipelineBody();
}
