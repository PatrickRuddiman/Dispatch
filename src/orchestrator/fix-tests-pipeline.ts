/**
 * Fix-tests pipeline — runs the project's test suite, captures failures,
 * and dispatches an AI agent to fix them.
 *
 * TODO: Full implementation in a subsequent task.
 */

import type { FixTestsSummary } from "../agents/orchestrator.js";
import { log } from "../logger.js";

export interface FixTestsPipelineOptions {
  cwd: string;
  provider: string;
  serverUrl?: string;
  verbose: boolean;
}

export async function runFixTestsPipeline(opts: FixTestsPipelineOptions): Promise<FixTestsSummary> {
  log.error("The --fix-tests pipeline is not yet implemented");
  return { mode: "fix-tests", success: false, error: "Not yet implemented" };
}
