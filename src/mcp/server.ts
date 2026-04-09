/**
 * MCP Server for Dispatch.
 *
 * Creates an McpServer backed by StreamableHTTPServerTransport, registers
 * all Dispatch tools, and wires the live-run log callback system so that
 * progress events from the dispatch/spec pipelines are forwarded to MCP
 * clients as logging notifications.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerSpecTools } from "./tools/spec.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerMonitorTools } from "./tools/monitor.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerConfigTools } from "./tools/config.js";
import { registerFixTestsTools } from "./tools/fix-tests.js";
import { addLogCallback } from "./state/manager.js";

export interface McpServerHandle {
  httpServer: http.Server;
  close(): Promise<void>;
}

export interface StdioMcpServerHandle {
  close(): Promise<void>;
}

/**
 * Create and return a running MCP stdio server.
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout.
 * All diagnostic output is written to stderr so it does not corrupt the
 * MCP protocol stream.
 *
 * @param cwd  Working directory for Dispatch commands
 */
export async function createStdioMcpServer(cwd: string): Promise<StdioMcpServerHandle> {
  const mcpServer = new McpServer(
    { name: "dispatch", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  // Register all tool groups
  registerSpecTools(mcpServer, cwd);
  registerDispatchTools(mcpServer, cwd);
  registerMonitorTools(mcpServer, cwd);
  registerRecoveryTools(mcpServer, cwd);
  registerConfigTools(mcpServer, cwd);
  registerFixTestsTools(mcpServer, cwd);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  return {
    close: async () => {
      await transport.close().catch((err: unknown) => {
        process.stderr.write(`[dispatch-mcp] transport.close error: ${String(err)}\n`);
      });
      await mcpServer.close().catch((err: unknown) => {
        process.stderr.write(`[dispatch-mcp] mcpServer.close error: ${String(err)}\n`);
      });
    },
  };
}

/**
 * Create and return a running MCP HTTP server.
 *
 * @param opts.port  TCP port to listen on (default 9110)
 * @param opts.host  Bind address (default "127.0.0.1")
 * @param opts.cwd   Working directory for Dispatch commands
 */
export async function createMcpServer(opts: {
  port: number;
  host: string;
  cwd: string;
}): Promise<McpServerHandle> {
  const { port, host, cwd } = opts;

  const mcpServer = new McpServer(
    { name: "dispatch", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  // Register all tool groups
  registerSpecTools(mcpServer, cwd);
  registerDispatchTools(mcpServer, cwd);
  registerMonitorTools(mcpServer, cwd);
  registerRecoveryTools(mcpServer, cwd);
  registerConfigTools(mcpServer, cwd);
  registerFixTestsTools(mcpServer, cwd);

  // Each connected transport gets its own transport instance (stateful mode).
  // We keep a map so POST /mcp requests carrying a session ID can be routed
  // to the correct existing transport.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url?.startsWith("/mcp")) {
      const rawSessionId = req.headers["mcp-session-id"];
      const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;

      if (req.method === "POST") {
        // Initialisation request (no session yet) or existing session
        if (!sessionId) {
          // New session — create a fresh transport
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);

              // Wire live-run log callbacks to this transport's session.
              // The runId we don't know yet (it's created at tool invocation time),
              // so we expose a broadcast helper instead that tools can call after
              // creating a run. The actual wiring happens in the tool handlers via
              // addLogCallback — we just need sendLoggingMessage available here.
            },
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
            }
          };

          // Connect the McpServer to this transport
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        // Route to existing transport
        const existing = transports.get(sessionId);
        if (!existing) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }

      if (req.method === "GET") {
        // SSE stream for server→client notifications.
        // If a session ID is provided, route to existing; otherwise create new.
        if (sessionId) {
          const existing = transports.get(sessionId);
          if (!existing) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          await existing.handleRequest(req, res);
          return;
        }

        // New GET without session — create a transport for SSE-only clients
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        if (sessionId) {
          const existing = transports.get(sessionId);
          if (existing) {
            await existing.handleRequest(req, res);
            transports.delete(sessionId);
            return;
          }
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      res.writeHead(405);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.once("error", reject);
  });

  return {
    httpServer,
    close: async () => {
      // Close all active transports
      for (const transport of transports.values()) {
        await transport.close().catch((err: unknown) => {
          console.error("[dispatch-mcp] transport.close error:", err);
        });
      }
      transports.clear();
      await mcpServer.close().catch((err: unknown) => {
        console.error("[dispatch-mcp] mcpServer.close error:", err);
      });
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Wire a live-run's log emissions into the MCP server as logging notifications.
 *
 * Call this right after creating a run (and before starting it) so that
 * progress messages are forwarded to all connected MCP clients.
 *
 * @param runId   The run ID to listen to
 * @param server  The McpServer instance
 */
export function wireRunLogs(runId: string, server: McpServer): void {
  addLogCallback(runId, (message, level) => {
    server.sendLoggingMessage({
      level: level === "error" ? "error" : level === "warn" ? "warning" : "info",
      logger: `dispatch.run.${runId}`,
      data: message,
    }).catch((err: unknown) => {
      console.error("[dispatch-mcp] sendLoggingMessage error:", err);
    });
  });
}
