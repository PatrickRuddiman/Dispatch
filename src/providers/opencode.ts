/**
 * OpenCode provider — wraps the @opencode-ai/sdk to conform to the
 * generic ProviderInstance interface.
 *
 * Uses the asynchronous prompt API (`promptAsync`) combined with SSE
 * event streaming to avoid HTTP timeout issues. The blocking `prompt()`
 * SDK method sends a single long-lived HTTP request that can exceed
 * Node.js/undici's default headers timeout for slow LLM responses.
 *
 * Flow:
 *   1. `promptAsync()` — fire-and-forget POST that returns 204 immediately
 *   2. `event.subscribe()` — SSE stream that yields session lifecycle events
 *   3. Wait for `session.idle` (success) or `session.error` (failure)
 *   4. `session.messages()` — fetch the completed response
 */

import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
  type TextPart,
  type Event as SdkEvent,
} from "@opencode-ai/sdk";
import type { ProviderInstance, ProviderBootOptions } from "../provider.js";
import { log } from "../logger.js";

/**
 * Boot an OpenCode instance — either connect to a running server
 * or start a new one.
 */
export async function boot(opts?: ProviderBootOptions): Promise<ProviderInstance> {
  let client: OpencodeClient;
  let stopServer: (() => void) | undefined;
  let cleaned = false;

  if (opts?.url) {
    log.debug(`Connecting to existing OpenCode server at ${opts.url}`);
    client = createOpencodeClient({ baseUrl: opts.url });
  } else {
    log.debug("No --server-url provided, spawning local OpenCode server...");
    try {
      const oc = await createOpencode();
      client = oc.client;
      stopServer = () => oc.server.close();
      log.debug("OpenCode server started successfully");
    } catch (err) {
      log.debug(`Failed to start OpenCode server: ${log.formatErrorChain(err)}`);
      throw err;
    }
  }

  return {
    name: "opencode",

    async createSession(): Promise<string> {
      log.debug("Creating OpenCode session...");
      try {
        const { data: session } = await client.session.create();
        if (!session) {
          throw new Error("Failed to create OpenCode session");
        }
        log.debug(`Session created: ${session.id}`);
        return session.id;
      } catch (err) {
        log.debug(`Session creation failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async prompt(sessionId: string, text: string): Promise<string | null> {
      log.debug(`Sending async prompt to session ${sessionId} (${text.length} chars)...`);

      try {
        // ── 1. Fire-and-forget: start the LLM processing ──────────
        const { error: promptError } = await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text }],
          },
        });

        if (promptError) {
          throw new Error(`OpenCode promptAsync failed: ${JSON.stringify(promptError)}`);
        }

        log.debug("Async prompt accepted, subscribing to events...");

        // ── 2. Subscribe to SSE events ────────────────────────────
        const controller = new AbortController();
        const { stream } = await client.event.subscribe({
          signal: controller.signal,
        });

        // ── 3. Wait for session to become idle or error ───────────
        try {
          for await (const event of stream) {
            if (!isSessionEvent(event, sessionId)) continue;

            if (
              event.type === "message.part.updated" &&
              event.properties.part.type === "text"
            ) {
              const delta = event.properties.delta;
              if (delta) {
                log.debug(`Streaming text (+${delta.length} chars)...`);
              }
              continue;
            }

            if (event.type === "session.error") {
              const err = event.properties.error;
              throw new Error(
                `OpenCode session error: ${err ? JSON.stringify(err) : "unknown error"}`
              );
            }

            if (event.type === "session.idle") {
              log.debug("Session went idle, fetching result...");
              break;
            }
          }
        } finally {
          controller.abort();
        }

        // ── 4. Fetch the completed message ────────────────────────
        const { data: messages } = await client.session.messages({
          path: { id: sessionId },
        });

        if (!messages || messages.length === 0) {
          log.debug("No messages found in session");
          return null;
        }

        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.info.role === "assistant");

        if (!lastAssistant) {
          log.debug("No assistant message found in session");
          return null;
        }

        // Check for errors on the assistant message
        if (lastAssistant.info.role === "assistant" && "error" in lastAssistant.info && lastAssistant.info.error) {
          throw new Error(
            `OpenCode assistant error: ${JSON.stringify(lastAssistant.info.error)}`
          );
        }

        // ── 5. Extract text parts ─────────────────────────────────
        const textParts = lastAssistant.parts.filter(
          (p: Part): p is TextPart => p.type === "text" && "text" in p
        );
        const result = textParts.map((p: TextPart) => p.text).join("\n") || null;
        log.debug(`Prompt response received (${result?.length ?? 0} chars)`);
        return result;
      } catch (err) {
        log.debug(`Prompt failed: ${log.formatErrorChain(err)}`);
        throw err;
      }
    },

    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      log.debug("Cleaning up OpenCode provider...");
      stopServer?.();
    },
  };
}

/**
 * Check whether an SSE event belongs to the given session.
 *
 * Different event types store the session ID in different places:
 *   - `session.*` events → `properties.sessionID`
 *   - `message.*` events → `properties.info.sessionID` or `properties.part.sessionID`
 */
function isSessionEvent(event: SdkEvent, sessionId: string): boolean {
  const props = event.properties as Record<string, unknown>;

  // Direct sessionID on the event (session.idle, session.error, session.status, etc.)
  if (props.sessionID === sessionId) return true;

  // Nested in .info (message.updated)
  if (
    props.info &&
    typeof props.info === "object" &&
    (props.info as Record<string, unknown>).sessionID === sessionId
  ) {
    return true;
  }

  // Nested in .part (message.part.updated)
  if (
    props.part &&
    typeof props.part === "object" &&
    (props.part as Record<string, unknown>).sessionID === sessionId
  ) {
    return true;
  }

  return false;
}
