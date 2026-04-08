/**
 * MCP tools: status_get, issues_list, issues_fetch, runs_list
 */

import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRun, listRuns, getTasksForRun, listRunsByStatus } from "../state/manager.js";
import { getDatasource } from "../../datasources/index.js";
import { loadConfig } from "../../config.js";
import { DATASOURCE_NAMES } from "../../datasources/interface.js";

export function registerMonitorTools(server: McpServer, cwd: string): void {
  // ── status_get ────────────────────────────────────────────────
  server.tool(
    "status_get",
    "Get the current status of a dispatch or spec run, including per-task details.",
    {
      runId: z.string().describe("The runId returned by dispatch_run or spec_generate"),
    },
    async (args) => {
      const run = getRun(args.runId);
      if (!run) {
        return {
          content: [{ type: "text", text: `Run ${args.runId} not found` }],
          isError: true,
        };
      }
      const tasks = getTasksForRun(args.runId);
      return {
        content: [{ type: "text", text: JSON.stringify({ run, tasks }) }],
      };
    }
  );

  // ── runs_list ─────────────────────────────────────────────────
  server.tool(
    "runs_list",
    "List recent dispatch runs with their status.",
    {
      status: z.enum(["running", "completed", "failed", "cancelled"]).optional()
        .describe("Filter by status (omit for all)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    },
    async (args) => {
      const runs = args.status
        ? listRunsByStatus(args.status, args.limit ?? 20)
        : listRuns(args.limit ?? 20);
      return {
        content: [{ type: "text", text: JSON.stringify(runs) }],
      };
    }
  );

  // ── issues_list ───────────────────────────────────────────────
  server.tool(
    "issues_list",
    "List open issues from the configured datasource.",
    {
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md (auto-detected if omitted)"),
      org: z.string().optional().describe("Azure DevOps organization URL"),
      project: z.string().optional().describe("Azure DevOps project name"),
      workItemType: z.string().optional(),
      iteration: z.string().optional(),
      area: z.string().optional(),
    },
    async (args) => {
      try {
        const config = await loadConfig(join(cwd, ".dispatch"));
        const sourceName = args.source ?? config.source;
        if (!sourceName) {
          return {
            content: [{ type: "text", text: "No datasource configured. Pass source or run dispatch config." }],
            isError: true,
          };
        }
        const datasource = getDatasource(sourceName);
        const items = await datasource.list({
          cwd,
          org: args.org ?? config.org,
          project: args.project ?? config.project,
          workItemType: args.workItemType ?? config.workItemType,
          iteration: args.iteration ?? config.iteration,
          area: args.area ?? config.area,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(items.map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: i.labels,
            url: i.url,
          }))) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ── issues_fetch ──────────────────────────────────────────────
  server.tool(
    "issues_fetch",
    "Fetch full details for one or more issues from the datasource.",
    {
      issueIds: z.array(z.string()).min(1).describe("Issue IDs to fetch"),
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md"),
      org: z.string().optional(),
      project: z.string().optional(),
    },
    async (args) => {
      try {
        const config = await loadConfig(join(cwd, ".dispatch"));
        const sourceName = args.source ?? config.source;
        if (!sourceName) {
          return {
            content: [{ type: "text", text: "No datasource configured. Pass source or run dispatch config." }],
            isError: true,
          };
        }
        const datasource = getDatasource(sourceName);
        const fetchOpts = {
          cwd,
          org: args.org ?? config.org,
          project: args.project ?? config.project,
        };
        const results = await Promise.all(
          args.issueIds.map(async (id) => {
            try {
              const details = await datasource.fetch(id, fetchOpts);
              return { id, details };
            } catch (err) {
              return { id, error: err instanceof Error ? err.message : String(err) };
            }
          })
        );
        return {
          content: [{ type: "text", text: JSON.stringify(results) }],
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
