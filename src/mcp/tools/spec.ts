/**
 * MCP tool: spec_generate, spec_list, spec_read
 */

import { z } from "zod";
import { join, resolve, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSpecRun, finishSpecRun, listSpecRuns, getSpecRun, waitForRunCompletion } from "../state/manager.js";
import { PROVIDER_NAMES } from "../../providers/interface.js";
import { DATASOURCE_NAMES } from "../../datasources/interface.js";
import { forkDispatchRun } from "./_fork-run.js";
import { loadMcpConfig } from "./_resolve-config.js";
import { getDatasource } from "../../datasources/index.js";

export function registerSpecTools(server: McpServer, cwd: string): void {
  // ── spec_generate ─────────────────────────────────────────────
  server.tool(
    "spec_generate",
    "Generate spec files from issue IDs, glob patterns, or inline text. Returns a runId immediately; progress is pushed via logging notifications.",
    {
      issues: z.string().describe(
        "Comma-separated issue IDs (e.g. '42,43'), a glob pattern (e.g. 'drafts/*.md'), or an inline description."
      ),
      provider: z.enum(PROVIDER_NAMES).optional().describe("Agent provider name (default: from config)"),
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md (default: from config)"),
      concurrency: z.number().int().min(1).max(32).optional().describe("Max parallel spec generations"),
      dryRun: z.boolean().optional().describe("Preview without generating"),
      respec: z.boolean().optional().describe("Regenerate existing specs (overwrites). When issues is '*' or empty, regenerates all discovered specs."),
    },
    async (args) => {
      let config;
      try {
        config = await loadMcpConfig(cwd, { provider: args.provider, source: args.source });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      // Respec: discover all existing spec IDs when issues is "*" or empty
      let resolvedIssues = args.issues;
      if (args.respec && (args.issues === "*" || args.issues.trim() === "")) {
        if (!config.source) {
          return {
            content: [{ type: "text", text: "No datasource configured. Pass source or run 'dispatch config'." }],
            isError: true,
          };
        }
        const datasource = getDatasource(config.source);
        const existing = await datasource.list({
          cwd,
          org: config.org,
          project: config.project,
          workItemType: config.workItemType,
          iteration: config.iteration,
          area: config.area,
        });
        if (existing.length === 0) {
          return {
            content: [{ type: "text", text: "No existing specs found to regenerate" }],
            isError: true,
          };
        }
        resolvedIssues = existing.map((item) => item.number).join(",");
      }

      const runId = createSpecRun({ cwd, issues: resolvedIssues });

      forkDispatchRun(runId, server, {
        type: "spec",
        cwd,
        opts: {
          issues: resolvedIssues,
          enabledProviders: config.enabledProviders,
          issueSource: config.source,
          org: config.org,
          project: config.project,
          workItemType: config.workItemType,
          iteration: config.iteration,
          area: config.area,
          concurrency: args.concurrency ?? config.concurrency,
          specTimeout: config.specTimeout,
          specWarnTimeout: config.specWarnTimeout,
          specKillTimeout: config.specKillTimeout,
          dryRun: args.dryRun,
          cwd,
        },
      }, {
        onDone: (result) => {
          if ("generated" in result) {
            finishSpecRun(runId, "completed", {
              total: result["total"] as number,
              generated: result["generated"] as number,
              failed: result["failed"] as number,
            });
          }
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "running" }) }],
      };
    }
  );

  // ── spec_list ─────────────────────────────────────────────────
  server.tool(
    "spec_list",
    "List spec files in the .dispatch/specs directory.",
    {},
    async () => {
      const specsDir = join(cwd, ".dispatch", "specs");
      let files: string[] = [];
      let dirError: string | undefined;
      try {
        const entries = await readdir(specsDir);
        files = entries.filter((f) => f.endsWith(".md")).sort();
      } catch (err) {
        const isNotFound = err instanceof Error && "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT";
        if (!isNotFound) {
          dirError = `Error reading specs directory: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      let recentRuns: unknown[] = [];
      let runsError: string | undefined;
      try {
        recentRuns = listSpecRuns(5);
      } catch (err) {
        runsError = `Could not load recent runs: ${err instanceof Error ? err.message : String(err)}`;
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ files, specsDir, recentRuns, ...(dirError ? { error: dirError } : {}), ...(runsError ? { runsWarning: runsError } : {}) }) }],
      };
    }
  );

  // ── spec_read ─────────────────────────────────────────────────
  server.tool(
    "spec_read",
    "Read the contents of a spec file.",
    {
      file: z.string().describe("Filename or full path of the spec file (e.g. '42-add-auth.md')"),
    },
    async (args) => {
      const specsDir = resolve(cwd, ".dispatch", "specs");
      // Resolve the candidate path — if the arg contains no path separators
      // treat it as a bare filename inside specsDir, otherwise resolve it
      // relative to specsDir (never as an absolute path from user input).
      const candidatePath = args.file.includes("/") || args.file.includes("\\")
        ? resolve(specsDir, args.file)
        : join(specsDir, args.file);

      // Bounds check: reject anything that escapes the specs directory
      if (!candidatePath.startsWith(specsDir + sep) && candidatePath !== specsDir) {
        return {
          content: [{ type: "text", text: `Access denied: path must be inside the specs directory` }],
          isError: true,
        };
      }

      try {
        const content = await readFile(candidatePath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      } catch (err) {
        const isNotFound = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
        const message = isNotFound
          ? `File not found: ${candidatePath}`
          : `Error reading ${candidatePath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // ── spec_runs_list ────────────────────────────────────────────
  server.tool(
    "spec_runs_list",
    "List recent spec generation runs with their status.",
    {
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    },
    async (args) => {
      try {
        const runs = listSpecRuns(args.limit ?? 20);
        return {
          content: [{ type: "text", text: JSON.stringify(runs) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ── spec_run_status ───────────────────────────────────────────
  server.tool(
    "spec_run_status",
    "Get the status of a specific spec generation run. Use waitMs to hold the response until the run completes or the timeout elapses.",
    {
      runId: z.string().describe("The runId returned by spec_generate"),
      waitMs: z.number().int().min(0).max(120000).optional().default(0)
        .describe("Hold response until run completes or timeout (ms). 0 = return immediately."),
    },
    async (args) => {
      try {
        let run = getSpecRun(args.runId);
        if (!run) {
          return {
            content: [{ type: "text", text: `Run ${args.runId} not found` }],
            isError: true,
          };
        }

        // Long-poll if requested and still running
        if (run.status === "running" && args.waitMs > 0) {
          const completed = await waitForRunCompletion(
            args.runId,
            args.waitMs,
            () => getSpecRun(args.runId)?.status ?? null,
          );
          if (completed) {
            run = getSpecRun(args.runId)!;
          }
        }

        const response: Record<string, unknown> = { ...run };
        if (run.status === "running") {
          response.retryAfterMs = 5000;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
