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
import { unstable_v2_createSession, type SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderInstance,
  ProviderBootOptions,
  ProviderPromptOptions,
} from "./interface.js";
import { createProgressReporter } from "./progress.js";
import { log } from "../helpers/logger.js";

/**
 * List available Claude models.
 *
 * The Claude Agent SDK does not expose a model listing API, so this returns
 * a hardcoded list of known Claude model identifiers.
 */
export async function listModels(_opts?: ProviderBootOptions): Promise<string[]> {
  return [
    "claude-haiku-3-5",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
  ];
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
          permissionMode: "acceptEdits" as const,
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
        for await (const msg of session.stream()) {
          if (msg.type === "assistant") {
            const msgText = msg.message.content
              .filter((block: { type: string }) => block.type === "text")
              .map((block: { type: string; text: string }) => block.text)
              .join("");
            if (msgText) {
              reporter.emit(msgText);
              parts.push(msgText);
            }
          }
        }

        const result = parts.join("") || null;
        log.debug(`Prompt response received (${result?.length ?? 0} chars)`);
        return result;
      } catch (err) {
        log.debug(`Prompt failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async cleanup(): Promise<void> {
      log.debug("Cleaning up Claude provider...");
      for (const session of sessions.values()) {
        try {
          session.close();
        } catch {}
      }
      sessions.clear();
    },
  };
}
