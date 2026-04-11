/**
 * Entry point for `dispatch mcp`.
 *
 * Opens the SQLite database, starts the MCP server (stdio by default, HTTP
 * when --http is passed), and registers signal handlers for graceful shutdown.
 */

import { join } from "node:path";
import { openDatabase, closeDatabase } from "./state/database.js";
import { markOrphanedRunsFailed } from "./state/manager.js";
import { createMcpServer, createStdioMcpServer } from "./server.js";
import { initRunQueue, getRunQueue } from "../queue/run-queue.js";
import { loadConfig, CONFIG_BOUNDS } from "../config.js";
import { defaultConcurrency } from "../spec-generator.js";

/** Default maxRuns: double the per-run concurrency heuristic, floor of 4. */
function defaultMaxRuns(): number {
  return Math.min(Math.max(4, defaultConcurrency() * 2), CONFIG_BOUNDS.maxRuns.max);
}

export interface McpServerOptions {
  port: number;
  host: string;
  cwd: string;
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const { port, host, cwd } = opts;

  // Initialise the SQLite database for this working directory
  openDatabase(cwd);

  // Clean up orphaned runs from prior crashes and init the run queue
  markOrphanedRunsFailed();
  const config = await loadConfig(join(cwd, ".dispatch"));
  initRunQueue(config.maxRuns ?? defaultMaxRuns());

  const handle = await createMcpServer({ port, host, cwd });

  console.log(`Dispatch MCP server listening on http://${host}:${port}/mcp`);
  console.log("Press Ctrl+C to stop.");

  async function shutdown(signal: string) {
    console.log(`\nReceived ${signal}, shutting down MCP server...`);
    try {
      getRunQueue().abort();
    } catch { /* queue may not be initialized */ }
    try {
      await handle.close();
    } catch (err) {
      console.error("[dispatch-mcp] Error during server close:", err);
    }
    try {
      closeDatabase();
    } catch (err) {
      console.error("[dispatch-mcp] Error closing database:", err);
    }
    process.exit(0);
  }

  // Fire-and-forget: signal handlers are intentionally not awaited — the
  // shutdown() function calls process.exit(0) itself when done.
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive — the HTTP server holds the event loop open.
}

export interface StdioMcpServerOptions {
  cwd: string;
}

export async function startStdioMcpServer(opts: StdioMcpServerOptions): Promise<void> {
  const { cwd } = opts;

  // Initialise the SQLite database for this working directory.
  // All status messages go to stderr so stdout stays clean for MCP protocol.
  openDatabase(cwd);

  // Clean up orphaned runs from prior crashes and init the run queue
  markOrphanedRunsFailed();
  const config = await loadConfig(join(cwd, ".dispatch"));
  initRunQueue(config.maxRuns ?? defaultMaxRuns());

  const handle = await createStdioMcpServer(cwd);

  process.stderr.write("Dispatch MCP server ready (stdio transport). Press Ctrl+C to stop.\n");

  async function shutdown(signal: string) {
    process.stderr.write(`\nReceived ${signal}, shutting down MCP server...\n`);
    try {
      getRunQueue().abort();
    } catch { /* queue may not be initialized */ }
    try {
      await handle.close();
    } catch (err) {
      process.stderr.write(`[dispatch-mcp] Error during server close: ${String(err)}\n`);
    }
    try {
      closeDatabase();
    } catch (err) {
      process.stderr.write(`[dispatch-mcp] Error closing database: ${String(err)}\n`);
    }
    process.exit(0);
  }

  // Fire-and-forget: signal handlers are intentionally not awaited — the
  // shutdown() function calls process.exit(0) itself when done.
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive — the StdioServerTransport holds stdin open.
}
