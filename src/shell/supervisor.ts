/**
 * Supervisor — keep-alive loop with SDK-based heartbeat for the orchestrator shell.
 *
 * For SDK-bridgeable providers (Copilot, OpenCode):
 *   - Boots the provider SDK alongside the CLI
 *   - Creates a session and uses provider.send() for heartbeats
 *   - Wires the state poller to push notifications via provider.send()
 *
 * For non-bridgeable providers (Claude, Codex):
 *   - Spawns the CLI only
 *   - Relies on MCP logging notifications and the restart loop
 */

import type { ProviderName } from "../providers/interface.js";
import type { ProviderInstance } from "../providers/interface.js";
import type { ShellLauncher } from "./launcher-interface.js";
import { bootProvider } from "../providers/index.js";
import { startStatePoller } from "./state-poller.js";
import { loadSystemPrompt, type ResumeContext } from "./system-prompt.js";
import { getInProgressRunSummary } from "./state-queries.js";
import { log } from "../helpers/logger.js";

/** Heartbeat interval in milliseconds (5 minutes). */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Options for the supervisor loop. */
export interface SupervisorOptions {
  provider: ProviderName;
  launcher: ShellLauncher;
  cwd: string;
  model?: string;
  initialPrompt?: string;
  /** Base restart delay in ms. Exponential backoff applied. Default: 2000. */
  restartDelayMs?: number;
  /** Maximum restart delay in ms. Default: 30000. */
  maxRestartDelayMs?: number;
}

/**
 * Run the supervisor loop. This function blocks until the user requests
 * a shutdown (Ctrl+C) or the provider exits cleanly (exit code 0).
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<void> {
  const {
    launcher,
    cwd,
    model,
    restartDelayMs = 2000,
    maxRestartDelayMs = 30000,
  } = opts;

  let shutdownRequested = false;
  let restartCount = 0;
  let currentSystemPrompt = await loadSystemPrompt(cwd);
  let currentUserPrompt = opts.initialPrompt;

  // Handle SIGINT/SIGTERM at the supervisor level
  const signalHandler = () => {
    shutdownRequested = true;
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  try {
    while (!shutdownRequested) {
      log.info(`Starting ${opts.provider} shell${restartCount > 0 ? ` (restart #${restartCount})` : ""}...`);

      const result = await launcher({
        cwd,
        model,
        systemPrompt: currentSystemPrompt,
        initialPrompt: currentUserPrompt,
      });

      const child = result.process;

      // ── SDK bridge for heartbeats and push notifications ──────
      let sdkInstance: ProviderInstance | null = null;
      let sdkSessionId: string | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let poller: ReturnType<typeof startStatePoller> | null = null;

      if (result.sdkBridgeable) {
        try {
          // Boot the provider SDK (starts its own server instance)
          sdkInstance = await bootProvider(opts.provider, { cwd, model });
          sdkSessionId = await sdkInstance.createSession();
          log.debug(`SDK bridge established for ${opts.provider} (session: ${sdkSessionId})`);

          // Send the system prompt to the SDK session so the agent has context
          await sdkInstance.prompt(sdkSessionId, currentSystemPrompt);

          // Wire the state poller to push notifications via SDK
          const sendNotification = (message: string) => {
            if (sdkInstance?.send && sdkSessionId) {
              sdkInstance.send(sdkSessionId, message).catch((err) => {
                log.debug(`SDK send failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          };

          poller = startStatePoller(sendNotification);

          // Start heartbeat timer — only sends when dispatch runs are active
          heartbeatTimer = setInterval(() => {
            if (!sdkInstance?.send || !sdkSessionId) return;

            try {
              const runs = getInProgressRunSummary();
              if (runs.length === 0) return; // no active dispatch work — skip heartbeat

              const inProgress = runs.filter((r) => r.status === "running").length;
              const queued = runs.filter((r) => r.status === "queued").length;

              sdkInstance.send(sdkSessionId!, `[Dispatch Heartbeat] Session active. ${inProgress} runs in progress, ${queued} queued.`).catch((err) => {
                log.debug(`Heartbeat send failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            } catch { /* DB might not be available */ }
          }, HEARTBEAT_INTERVAL_MS);
        } catch (err) {
          log.debug(`SDK bridge setup failed: ${err instanceof Error ? err.message : String(err)}. Continuing without heartbeat.`);
          sdkInstance = null;
          sdkSessionId = null;
        }
      }

      // Forward signals to child
      const forwardSignal = (signal: NodeJS.Signals) => {
        shutdownRequested = true;
        child.kill(signal);
      };

      process.on("SIGINT", forwardSignal);
      process.on("SIGTERM", forwardSignal);

      // Wait for the child process to exit
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
        child.on("error", (err) => {
          log.error(`Provider process error: ${err.message}`);
          resolve(1);
        });
      });

      // Clean up
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      poller?.stop();
      if (sdkInstance) {
        await sdkInstance.cleanup().catch((err) => {
          log.debug(`SDK cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      await result.cleanup();

      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);

      // Decide whether to restart
      if (shutdownRequested) {
        log.info("Shutdown requested. Exiting.");
        break;
      }

      if (exitCode === 0) {
        log.info("Provider exited cleanly. Exiting.");
        break;
      }

      // Provider died unexpectedly — prepare to restart
      restartCount++;

      // Query DB for in-progress runs to build resume context
      let resumeContext: ResumeContext | undefined;
      try {
        const runs = getInProgressRunSummary();
        if (runs.length > 0) {
          resumeContext = { runs };
        }
      } catch {
        // DB might not be available — restart without resume context
      }

      // Build resume system prompt and clear user prompt (resume context replaces it)
      currentSystemPrompt = await loadSystemPrompt(cwd, resumeContext);
      currentUserPrompt = undefined;

      // Exponential backoff
      const delay = Math.min(restartDelayMs * Math.pow(2, restartCount - 1), maxRestartDelayMs);
      log.info(`Provider exited with code ${exitCode}. Restarting in ${(delay / 1000).toFixed(0)}s...`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }
}
