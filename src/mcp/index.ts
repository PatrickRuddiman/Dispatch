/**
 * Entry point for `dispatch mcp`.
 *
 * Opens the SQLite database, starts the MCP HTTP server, and registers
 * signal handlers for graceful shutdown.
 */

import { openDatabase, closeDatabase } from "./state/database.js";
import { createMcpServer } from "./server.js";

export interface McpServerOptions {
  port: number;
  host: string;
  cwd: string;
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const { port, host, cwd } = opts;

  // Initialise the SQLite database for this working directory
  openDatabase(cwd);

  const handle = await createMcpServer({ port, host, cwd });

  console.log(`Dispatch MCP server listening on http://${host}:${port}/mcp`);
  console.log("Press Ctrl+C to stop.");

  async function shutdown(signal: string) {
    console.log(`\nReceived ${signal}, shutting down MCP server...`);
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

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive — the HTTP server holds the event loop open.
}
