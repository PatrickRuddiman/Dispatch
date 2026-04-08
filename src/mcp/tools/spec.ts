/**
 * MCP tool: spec_generate, spec_list, spec_read
 */

import { z } from "zod";
import { join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSpecPipeline } from "../../orchestrator/spec-pipeline.js";
import { createSpecRun, finishSpecRun, listSpecRuns, getSpecRun, emitLog } from "../state/manager.js";
import type { SpecStatus } from "../state/database.js";
import { PROVIDER_NAMES } from "../../providers/interface.js";
import { DATASOURCE_NAMES } from "../../datasources/interface.js";

export function registerSpecTools(server: McpServer, cwd: string): void {
  // ── spec_generate ─────────────────────────────────────────────
  server.tool(
    "spec_generate",
    "Generate spec files from issue IDs, glob patterns, or inline text. Returns a runId immediately; progress is pushed via logging notifications.",
    {
      issues: z.string().describe(
        "Comma-separated issue IDs (e.g. '42,43'), a glob pattern (e.g. 'drafts/*.md'), or an inline description."
      ),
      provider: z.enum(PROVIDER_NAMES).optional().describe("Agent provider name (default: opencode)"),
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md"),
      concurrency: z.number().int().min(1).max(32).optional().describe("Max parallel spec generations"),
      dryRun: z.boolean().optional().describe("Preview without generating"),
    },
    async (args) => {
      const runId = createSpecRun({ cwd, issues: args.issues });

      // Fire-and-forget — tools return runId immediately
      setImmediate(() => { void (async () => {
        try {
          emitLog(runId, `Starting spec generation for: ${args.issues}`);
          const result = await runSpecPipeline({
            issues: args.issues,
            provider: args.provider ?? "opencode",
            issueSource: args.source,
            concurrency: args.concurrency,
            dryRun: args.dryRun,
            cwd,
            progressCallback: (event) => {
              switch (event.type) {
                case "item_start":
                  emitLog(runId, `Generating spec for: ${event.itemTitle ?? event.itemId}`);
                  break;
                case "item_done":
                  emitLog(runId, `Spec done: ${event.itemTitle ?? event.itemId}`);
                  break;
                case "item_failed":
                  emitLog(runId, `Spec failed: ${event.itemTitle ?? event.itemId} — ${event.error}`, "error");
                  break;
                case "log":
                  emitLog(runId, event.message);
                  break;
                default: {
                  const _exhaustive: never = event;
                  void _exhaustive;
                }
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
      })(); });

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
      const specsDir = resolve(cwd, ".dispatch", "specs");
      // Resolve the candidate path — if the arg contains no path separators
      // treat it as a bare filename inside specsDir, otherwise resolve it
      // relative to specsDir (never as an absolute path from user input).
      const candidatePath = args.file.includes("/") || args.file.includes("\\")
        ? resolve(specsDir, args.file)
        : join(specsDir, args.file);

      // Bounds check: reject anything that escapes the specs directory
      if (!candidatePath.startsWith(specsDir + "/") && candidatePath !== specsDir) {
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
