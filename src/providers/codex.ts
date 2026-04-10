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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * Resolve an API bearer token for OpenAI.
 *
 * Checks OPENAI_API_KEY env var first, then reads the Codex CLI's
 * OAuth access_token from ~/.codex/auth.json (set by `codex login`).
 */
async function resolveOpenAIToken(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const raw = JSON.parse(await readFile(authPath, "utf-8"));
    return raw?.tokens?.access_token ?? null;
  } catch (err) {
    log.debug(`resolveOpenAIToken: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * List available Codex models.
 *
 * Tries the OpenAI /v1/models endpoint first (works with API keys).
 * Falls back to a known model list when using ChatGPT OAuth (which
 * lacks the api.model.read scope needed for the models endpoint).
 */
export async function listModels(_opts?: ProviderBootOptions): Promise<string[]> {
  try {
    const token = await resolveOpenAIToken();
    if (!token) return [];

    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });

    if (resp.ok) {
      const data = (await resp.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id).sort();
    }
  } catch {
    // Fall through to known models
  }

  // ChatGPT OAuth tokens lack api.model.read scope — return known models
  return [
    "codex-mini-latest",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "o3",
    "o3-mini",
    "o3-pro",
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
