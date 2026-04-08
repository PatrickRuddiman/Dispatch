/**
 * MCP tool: spec_generate, spec_list, spec_read
 */

import { z } from "zod";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSpecPipeline } from "../../orchestrator/spec-pipeline.js";
import { createSpecRun, finishSpecRun, listSpecRuns, getSpecRun, emitLog } from "../state/manager.js";
import type { SpecStatus } from "../state/database.js";

export function registerSpecTools(server: McpServer, cwd: string): void {
  // ── spec_generate ─────────────────────────────────────────────
  server.tool(
    "spec_generate",
    "Generate spec files from issue IDs, glob patterns, or inline text. Returns a runId immediately; progress is pushed via logging notifications.",
    {
      issues: z.string().describe(
        "Comma-separated issue IDs (e.g. '42,43'), a glob pattern (e.g. 'drafts/*.md'), or an inline description."
      ),
      provider: z.string().optional().describe("Agent provider name (default: opencode)"),
      source: z.string().optional().describe("Issue datasource: github, azdevops, md"),
      concurrency: z.number().int().min(1).max(32).optional().describe("Max parallel spec generations"),
      dryRun: z.boolean().optional().describe("Preview without generating"),
    },
    async (args) => {
      const runId = createSpecRun({ cwd, issues: args.issues });

      // Fire-and-forget — tools return runId immediately
      setImmediate(async () => {
        try {
          emitLog(runId, `Starting spec generation for: ${args.issues}`);
          const result = await runSpecPipeline({
            issues: args.issues,
            provider: (args.provider as any) ?? "opencode",
            issueSource: args.source as any,
            concurrency: args.concurrency,
            dryRun: args.dryRun,
            cwd,
            progressCallback: (event) => {
              if (event.type === "item_start") {
                emitLog(runId, `Generating spec for: ${event.itemTitle ?? event.itemId}`);
              } else if (event.type === "item_done") {
                emitLog(runId, `Spec done: ${event.itemTitle ?? event.itemId}`);
              } else if (event.type === "item_failed") {
                emitLog(runId, `Spec failed: ${event.itemTitle ?? event.itemId} — ${event.error}`, "error");
              }
            },
          });
          finishSpecRun(runId, "completed", {
            total: result.total,
            generated: result.generated,
            failed: result.failed,
          });
          emitLog(runId, `Spec generation complete: ${result.generated} generated, ${result.failed} failed`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          finishSpecRun(runId, "failed", { total: 0, generated: 0, failed: 0 }, msg);
          emitLog(runId, `Spec generation error: ${msg}`, "error");
        }
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
      try {
        const entries = await readdir(specsDir);
        files = entries.filter((f) => f.endsWith(".md")).sort();
      } catch {
        // Directory doesn't exist yet
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ files, specsDir }) }],
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
      const filePath = args.file.includes("/")
        ? args.file
        : join(cwd, ".dispatch", "specs", args.file);
      try {
        const content = await readFile(filePath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}` }],
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
      const runs = listSpecRuns(args.limit ?? 20);
      return {
        content: [{ type: "text", text: JSON.stringify(runs) }],
      };
    }
  );

  // ── spec_run_status ───────────────────────────────────────────
  server.tool(
    "spec_run_status",
    "Get the status of a specific spec generation run.",
    {
      runId: z.string().describe("The runId returned by spec_generate"),
    },
    async (args) => {
      const run = getSpecRun(args.runId);
      if (!run) {
        return {
          content: [{ type: "text", text: `Run ${args.runId} not found` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(run) }],
      };
    }
  );
}
