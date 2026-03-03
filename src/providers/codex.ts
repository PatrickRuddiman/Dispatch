/**
 * Codex provider — wraps the @openai/codex SDK to conform to the
 * generic ProviderInstance interface.
 *
 * Uses the AgentLoop class for session management. Each session creates
 * its own AgentLoop instance with "full-auto" approval policy so that
 * file edits and shell commands are auto-approved.
 */

import { randomUUID } from "node:crypto";
import { AgentLoop } from "@openai/codex";
import type { ProviderInstance, ProviderBootOptions } from "./interface.js";
import { log } from "../helpers/logger.js";

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

  const sessions = new Map<string, AgentLoop>();

  return {
    name: "codex",
    model,

    async createSession(): Promise<string> {
      log.debug("Creating Codex session...");
      try {
        const sessionId = randomUUID();
        const agent = new AgentLoop({
          model,
          config: { model, instructions: "" },
          approvalPolicy: "full-auto",
          additionalWritableRoots: opts?.cwd ? [opts.cwd] : [],
          getCommandConfirmation: async () => ({ approved: true }),
          onItem: () => {},
          onLoading: () => {},
          onLastResponseId: () => {},
        });
        sessions.set(sessionId, agent);
        log.debug(`Session created: ${sessionId}`);
        return sessionId;
      } catch (err) {
        log.debug(`Session creation failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async prompt(sessionId: string, text: string): Promise<string | null> {
      const agent = sessions.get(sessionId);
      if (!agent) {
        throw new Error(`Codex session ${sessionId} not found`);
      }

      log.debug(`Sending prompt to session ${sessionId} (${text.length} chars)...`);
      try {
        const items = await agent.run([text]);

        const parts: string[] = [];
        for (const item of items) {
          if (item.type === "message" && "content" in item) {
            const content = (item as { type: string; content: Array<{ type: string; text?: string }> }).content;
            const itemText = content
              .filter((block: { type: string }) => block.type === "output_text")
              .map((block: { type: string; text?: string }) => block.text ?? "")
              .join("");
            if (itemText) parts.push(itemText);
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
      log.debug("Cleaning up Codex provider...");
      for (const agent of sessions.values()) {
        try { agent.terminate(); } catch {}
      }
      sessions.clear();
    },
  };
}
