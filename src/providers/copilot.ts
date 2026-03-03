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
 * List available Copilot models.
 *
 * Starts a temporary client, fetches the model list, then stops it.
 * Returns bare model IDs (e.g. "claude-sonnet-4-5").
 */
export async function listModels(opts?: ProviderBootOptions): Promise<string[]> {
  const client = new CopilotClient({
    ...(opts?.url ? { cliUrl: opts.url } : {}),
  });
  try {
    await client.start();
    const models = await client.listModels();
    return models.map((m) => m.id).sort();
  } finally {
    await client.stop().catch(() => {});
  }
}

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

  // Model is detected lazily after the first session is created
  let model: string | undefined;
  let modelDetected = false;

  // Track live sessions for prompt routing and cleanup
  const sessions = new Map<string, CopilotSession>();

  return {
    name: "copilot",
    get model() {
      return model;
    },

    async createSession(): Promise<string> {
      log.debug("Creating Copilot session...");
      try {
        const session = await client.createSession({
          ...(opts?.model ? { model: opts.model } : {}),
          onPermissionRequest: approveAll,
        });
        sessions.set(session.sessionId, session);
        log.debug(`Session created: ${session.sessionId}`);

        // Detect actual default model from the first session (best-effort, once only)
        if (!modelDetected) {
          modelDetected = true;
          try {
            const result = await session.rpc.model.getCurrent();
            if (result.modelId) {
              model = result.modelId;
              log.debug(`Detected model: ${model}`);
            }
          } catch (err) {
            log.debug(`Failed to detect model from session: ${log.formatErrorChain(err)}`);
          }
        }

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
        s.destroy().catch((err) => {
          log.debug(`Failed to destroy Copilot session: ${log.formatErrorChain(err)}`);
        })
      );
      await Promise.all(destroyOps);
      sessions.clear();

      await client.stop().catch((err) => {
        log.debug(`Failed to stop Copilot client: ${log.formatErrorChain(err)}`);
      });
    },
  };
}
