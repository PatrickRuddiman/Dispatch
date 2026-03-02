/**
 * GitHub Copilot provider — wraps the @github/copilot-sdk to conform
 * to the generic ProviderInstance interface.
 *
 * Requires the `copilot` CLI to be installed and available on PATH
 * (or specify the path via COPILOT_CLI_PATH).
 *
 * Authentication options:
 *   - Logged-in Copilot CLI user (default)
 *   - COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env vars
 */

import { CopilotClient, approveAll, type AssistantMessageEvent, type CopilotSession } from "@github/copilot-sdk";
import type { ProviderInstance, ProviderBootOptions } from "./interface.js";
import { log } from "../helpers/logger.js";

/**
 * Boot a Copilot provider instance — starts or connects to a Copilot CLI server.
 */
export async function boot(opts?: ProviderBootOptions): Promise<ProviderInstance> {
  log.debug(opts?.url ? `Connecting to Copilot CLI at ${opts.url}` : "Starting Copilot CLI...");

  const client = new CopilotClient({
    ...(opts?.url ? { cliUrl: opts.url } : {}),
  });

  try {
    await client.start();
    log.debug("Copilot CLI started successfully");
  } catch (err) {
    log.debug(`Failed to start Copilot CLI: ${log.formatErrorChain(err)}`);
    throw err;
  }

  // ── Retrieve the active model (best-effort) ──────────────────
  let model: string | undefined;
  try {
    const models = await client.listModels();
    if (models.length > 0) {
      model = models[0].id;
      log.debug(`Detected model: ${model}`);
    }
  } catch (err) {
    log.debug(`Failed to retrieve model from Copilot: ${log.formatErrorChain(err)}`);
  }

  // Track live sessions for prompt routing and cleanup
  const sessions = new Map<string, CopilotSession>();

  return {
    name: "copilot",
    model,

    async createSession(): Promise<string> {
      log.debug("Creating Copilot session...");
      try {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        sessions.set(session.sessionId, session);
        log.debug(`Session created: ${session.sessionId}`);
        return session.sessionId;
      } catch (err) {
        log.debug(`Session creation failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async prompt(sessionId: string, text: string): Promise<string | null> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Copilot session ${sessionId} not found`);
      }

      log.debug(`Sending prompt to session ${sessionId} (${text.length} chars)...`);
      try {
        // ── 1. Fire-and-forget: start LLM processing ──────────────
        await session.send({ prompt: text });
        log.debug("Async prompt accepted, waiting for session to become idle...");

        // ── 2. Wait for session.idle or session.error ─────────────
        await new Promise<void>((resolve, reject) => {
          const unsubIdle = session.on("session.idle", () => {
            unsubIdle();
            unsubErr();
            resolve();
          });

          const unsubErr = session.on("session.error", (event) => {
            unsubIdle();
            unsubErr();
            reject(new Error(`Copilot session error: ${event.data.message}`));
          });
        });

        log.debug("Session went idle, fetching result...");

        // ── 3. Fetch the completed messages ───────────────────────
        const events = await session.getMessages();
        const last = [...events]
          .reverse()
          .find((e) => e.type === "assistant.message") as AssistantMessageEvent | undefined;

        const result = last?.data?.content ?? null;
        log.debug(`Prompt response received (${result?.length ?? 0} chars)`);
        return result;
      } catch (err) {
        log.debug(`Prompt failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async cleanup(): Promise<void> {
      log.debug("Cleaning up Copilot provider...");
      // Destroy all active sessions before stopping the server
      const destroyOps = [...sessions.values()].map((s) =>
        s.destroy().catch(() => {})
      );
      await Promise.all(destroyOps);
      sessions.clear();

      await client.stop().catch(() => {});
    },
  };
}
