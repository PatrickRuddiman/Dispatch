/**
 * Codex provider — wraps the @openai/codex-sdk to conform to the
 * generic ProviderInstance interface.
 *
 * Uses the Codex class for agent lifecycle and Thread for per-session
 * conversation management. Each session starts a new Thread with
 * "never" approval policy so file edits and shell commands are
 * auto-approved.
 *
 * Supports both blocking (`thread.run()`) and streaming
 * (`thread.runStreamed()`) execution modes — streaming is used when
 * an `onProgress` callback is provided, falling back to blocking
 * otherwise.
 */

import { randomUUID } from "node:crypto";
import type {
  ProviderInstance,
  ProviderBootOptions,
  ProviderPromptOptions,
} from "./interface.js";
import { createProgressReporter } from "./progress.js";
import { log } from "../helpers/logger.js";
import { withTimeout } from "../helpers/timeout.js";

/** Maximum time (ms) to wait for a Codex thread.run() to complete. */
const SESSION_READY_TIMEOUT_MS = 600_000;

/**
 * Lazily load the @openai/codex-sdk.
 *
 * Using a dynamic import defers resolution to runtime so that only code
 * paths that actually exercise the Codex provider pay the cost of loading
 * the SDK, keeping startup fast for users of other providers.
 */
async function loadCodexSdk(): Promise<typeof import("@openai/codex-sdk")> {
  return import("@openai/codex-sdk");
}

/**
 * List available Codex models.
 *
 * The Codex SDK does not expose a model listing API, so this returns
 * a hardcoded list of known compatible model identifiers.
 */
export async function listModels(_opts?: ProviderBootOptions): Promise<string[]> {
  return [
    "codex-mini-latest",
    "o3-mini",
    "o4-mini",
  ];
}

/**
 * Boot a Codex provider instance.
 */
export async function boot(opts?: ProviderBootOptions): Promise<ProviderInstance> {
  const model = opts?.model ?? "o4-mini";
  log.debug(`Booting Codex provider with model ${model}`);

  const { Codex, Thread } = await loadCodexSdk();

  const codex = new Codex();

  type ThreadInstance = InstanceType<typeof Thread>;

  const sessions = new Map<string, ThreadInstance>();

  return {
    name: "codex",
    model,

    async createSession(): Promise<string> {
      log.debug("Creating Codex session...");
      try {
        const sessionId = randomUUID();
        const thread = codex.startThread({
          model,
          approvalPolicy: "never",
          sandboxMode: "workspace-write",
          ...(opts?.cwd ? { workingDirectory: opts.cwd } : {}),
        });
        sessions.set(sessionId, thread);
        log.debug(`Session created: ${sessionId}`);
        return sessionId;
      } catch (err) {
        log.debug(`Session creation failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async prompt(
      sessionId: string,
      text: string,
      options?: ProviderPromptOptions,
    ): Promise<string | null> {
      const thread = sessions.get(sessionId);
      if (!thread) {
        throw new Error(`Codex session ${sessionId} not found`);
      }

      log.debug(`Sending prompt to session ${sessionId} (${text.length} chars)...`);
      const reporter = createProgressReporter(options?.onProgress);
      try {
        reporter.emit("Waiting for Codex response");

        if (options?.onProgress) {
          // ── Streaming mode: emit progress as events arrive ──────
          const { events } = await withTimeout(
            thread.runStreamed(text),
            SESSION_READY_TIMEOUT_MS,
            "codex thread runStreamed",
          );

          let lastAgentMessage: string | null = null;

          for await (const event of events) {
            if (event.type === "item.updated" || event.type === "item.completed") {
              if (event.item.type === "agent_message") {
                lastAgentMessage = event.item.text;
                reporter.emit(event.item.text);
              }
            }

            if (event.type === "turn.failed") {
              throw new Error(`Codex turn failed: ${event.error.message}`);
            }

            if (event.type === "item.completed" && event.item.type === "error") {
              throw new Error(`Codex error: ${event.item.message}`);
            }
          }

          reporter.emit("Finalizing response");
          log.debug(`Prompt response received (${lastAgentMessage?.length ?? 0} chars, streaming)`);
          return lastAgentMessage;
        }

        // ── Blocking mode: wait for completed turn ─────────────
        const turn = await withTimeout(
          thread.run(text),
          SESSION_READY_TIMEOUT_MS,
          "codex thread run",
        );

        // Check for error items
        for (const item of turn.items) {
          if (item.type === "error") {
            throw new Error(`Codex error: ${item.message}`);
          }
        }

        reporter.emit("Finalizing response");
        const result = turn.finalResponse || null;
        log.debug(`Prompt response received (${result?.length ?? 0} chars)`);
        return result;
      } catch (err) {
        log.debug(`Prompt failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async send(sessionId: string, text: string): Promise<void> {
      const thread = sessions.get(sessionId);
      if (!thread) {
        throw new Error(`Codex session ${sessionId} not found`);
      }

      // Threads support multiple turns — send a follow-up as a new turn.
      // Fire-and-forget: start the turn but don't wait for completion.
      log.debug(`Sending follow-up to session ${sessionId} (${text.length} chars)...`);
      thread.run(text).catch((err) => {
        log.debug(`Follow-up turn failed: ${log.formatErrorChain(err)}`);
      });
    },

    async cleanup(): Promise<void> {
      log.debug("Cleaning up Codex provider...");
      sessions.clear();
    },
  };
}
