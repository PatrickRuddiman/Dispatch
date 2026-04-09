/**
 * Claude provider — wraps the @anthropic-ai/claude-agent-sdk V2 preview
 * to conform to the generic ProviderInstance interface.
 *
 * Uses the V2 session-based API: `unstable_v2_createSession` for session
 * creation, `session.send()`/`session.stream()` for prompting, and manual
 * `session.close()` for cleanup (the project targets ES2022 which does not
 * include the Disposable lib required for `await using`).
 */

import { randomUUID } from "node:crypto";
import { query, unstable_v2_createSession, type Options, type ModelInfo, type SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderInstance,
  ProviderBootOptions,
  ProviderPromptOptions,
} from "./interface.js";
import { createProgressReporter } from "./progress.js";
import { log } from "../helpers/logger.js";
import { withTimeout } from "../helpers/timeout.js";

/** Maximum time (ms) to wait for a Claude session stream to complete after sending a prompt. */
const SESSION_READY_TIMEOUT_MS = 600_000;

/**
 * List available Claude models.
 *
 * Uses the V1 query() API to ask the SDK for supported models at runtime.
 * Falls back to a hardcoded list if the dynamic query fails.
 */
export async function listModels(opts?: ProviderBootOptions): Promise<string[]> {
  try {
    const queryOpts: Options = {
      model: opts?.model ?? "claude-sonnet-4",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    const q = query({ prompt: "", options: queryOpts });
    try {
      const models = await q.supportedModels();
      return models.map((m: ModelInfo) => m.value).sort();
    } finally {
      q.close();
    }
  } catch (err) {
    log.debug(`Failed to list models dynamically: ${log.formatErrorChain(err)}`);
    return [
      "claude-haiku-3-5",
      "claude-opus-4-6",
      "claude-sonnet-4",
      "claude-sonnet-4-5",
    ];
  }
}

/**
 * Boot a Claude provider instance using the V2 preview API.
 */
export async function boot(opts?: ProviderBootOptions): Promise<ProviderInstance> {
  const model = opts?.model ?? "claude-sonnet-4";
  const cwd = opts?.cwd;
  log.debug(`Booting Claude provider with model ${model}`);

  const sessions = new Map<string, SDKSession>();

  return {
    name: "claude",
    model,

    async createSession(): Promise<string> {
      log.debug("Creating Claude session...");
      try {
        const sessionOpts = {
          model,
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
          ...(cwd ? { cwd } : {}),
        };
        const session = unstable_v2_createSession(sessionOpts);
        const sessionId = randomUUID();
        sessions.set(sessionId, session);
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
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Claude session ${sessionId} not found`);
      }

      log.debug(`Sending prompt to session ${sessionId} (${text.length} chars)...`);
      const reporter = createProgressReporter(options?.onProgress);
      try {
        await session.send(text);

        const parts: string[] = [];
        let receivedAssistant = false;

        await withTimeout(
          (async () => {
            for await (const msg of session.stream()) {
              if (msg.type === "assistant") {
                receivedAssistant = true;
                const msgText = msg.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => (block as { text: string }).text)
                  .join("");
                if (msgText) {
                  reporter.emit(msgText);
                  parts.push(msgText);
                }
              }
            }
          })(),
          SESSION_READY_TIMEOUT_MS,
          "claude session stream",
        );

        if (!receivedAssistant) {
          throw new Error("Claude stream ended before receiving an assistant message");
        }

        const result = parts.join("") || null;
        log.debug(`Prompt response received (${result?.length ?? 0} chars)`);
        return result;
      } catch (err) {
        log.debug(`Prompt failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async send(sessionId: string, text: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Claude session ${sessionId} not found`);
      }

      log.debug(`Sending follow-up to session ${sessionId} (${text.length} chars)...`);
      try {
        await session.send(text);
      } catch (err) {
        log.debug(`Follow-up send failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async cleanup(): Promise<void> {
      log.debug("Cleaning up Claude provider...");
      for (const session of sessions.values()) {
        try {
          // session.close() may return a promise — await it so cleanup errors
          // are surfaced in debug logs rather than becoming unhandled rejections.
          await Promise.resolve(session.close());
        } catch (err) {
          log.debug(`Failed to close Claude session: ${log.formatErrorChain(err)}`);
        }
      }
      sessions.clear();
    },
  };
}
