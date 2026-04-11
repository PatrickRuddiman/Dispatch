/**
 * State queries for the shell supervisor — queries the Dispatch SQLite
 * database for in-progress run information used to build resume context.
 */

import { listRunsByStatus } from "../mcp/state/manager.js";

/** Summary of an in-progress run for resume context. */
export interface RunSummary {
  runId: string;
  issueIds: string[];
  status: string;
}

/**
 * Get a summary of all in-progress (running or queued) runs.
 * Used by the supervisor to build resume context after a restart.
 */
export function getInProgressRunSummary(): RunSummary[] {
  const results: RunSummary[] = [];

  for (const status of ["running", "queued"] as const) {
    const runs = listRunsByStatus(status, 50);
    for (const run of runs) {
      let issueIds: string[];
      try {
        const parsed = JSON.parse(run.issueIds);
        issueIds = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
      } catch {
        issueIds = [run.issueIds];
      }

      results.push({
        runId: run.runId,
        issueIds,
        status: run.status,
      });
    }
  }

  return results;
}
