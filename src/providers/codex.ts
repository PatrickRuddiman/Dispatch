/**
 * Codex provider — wraps the @openai/codex SDK to conform to the
 * generic ProviderInstance interface.
 *
 * Uses the AgentLoop class for session management. Each session creates
 * its own AgentLoop instance with "full-auto" approval policy so that
 * file edits and shell commands are auto-approved.
 */

import { randomUUID } from "node:crypto";
import type {
  ProviderInstance,
  ProviderBootOptions,
  ProviderPromptOptions,
} from "./interface.js";
import { createProgressReporter } from "./progress.js";
import { log } from "../helpers/logger.js";

/**
 * Lazily load the @openai/codex SDK.
 *
 * The package ships as a CLI bundle without a proper library entry-point
 * (no `main` / `module` / `exports` in its package.json).  A top-level
 * static `import` would cause Vite's import analysis to fail at test time
 * for every test file that transitively touches the provider registry.
 * Using a dynamic import defers resolution to runtime so that only code
 * paths that actually exercise the Codex provider pay the cost.
 */
async function loadAgentLoop(): Promise<typeof import("@openai/codex")> {
  return import("@openai/codex");
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

  const { AgentLoop } = await loadAgentLoop();

  type AgentLoopInstance = InstanceType<typeof AgentLoop>;

  interface CodexSessionState {
    agent: AgentLoopInstance;
    onProgress?: ProviderPromptOptions["onProgress"];
    reporter: ReturnType<typeof createProgressReporter>;
    loadingReported: boolean;
  }

  const sessions = new Map<string, CodexSessionState>();

  return {
    name: "codex",
    model,

    async createSession(): Promise<string> {
      log.debug("Creating Codex session...");
      try {
        const sessionId = randomUUID();
        const state: CodexSessionState = {
          agent: undefined as never,
          reporter: createProgressReporter(),
          loadingReported: false,
        };

        const agent = new AgentLoop({
          model,
          config: { model, instructions: "" },
          approvalPolicy: "full-auto",
          ...(opts?.cwd ? { rootDir: opts.cwd } : {}),
          additionalWritableRoots: [],
          getCommandConfirmation: async () => ({ approved: true }),
          onItem: (item: unknown) => {
            if (
              item &&
              typeof item === "object" &&
              "type" in item &&
              item.type === "message" &&
              "content" in item &&
              Array.isArray(item.content)
            ) {
              const itemText = item.content
                .filter(
                  (block): block is { type: string; text?: string } =>
                    Boolean(block) &&
                    typeof block === "object" &&
                    "type" in block &&
                    block.type === "output_text"
                )
                .map((block) => block.text ?? "")
                .join("");
              if (itemText) {
                state.reporter.emit(itemText);
              }
            }
          },
          onLoading: () => {
            if (state.loadingReported) return;

            state.loadingReported = true;
            state.reporter.emit("thinking");
          },
          onLastResponseId: () => {},
        });

        state.agent = agent;
        sessions.set(sessionId, state);
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
      const state = sessions.get(sessionId);
      if (!state) {
        throw new Error(`Codex session ${sessionId} not found`);
      }

      log.debug(`Sending prompt to session ${sessionId} (${text.length} chars)...`);
      state.onProgress = options?.onProgress;
      state.reporter = createProgressReporter(state.onProgress);
      state.loadingReported = false;
      try {
        state.reporter.emit("Waiting for Codex response");
        const items = await state.agent.run([text]);

        const parts: string[] = [];
        for (const item of items) {
          if (item.type === "message" && "content" in item) {
            const content = (item as { type: string; content: Array<{ type: string; text?: string }> }).content;
            const itemText = content
              .filter((block: { type: string }) => block.type === "output_text")
              .map((block: { type: string; text?: string }) => block.text ?? "")
              .join("");
            if (itemText) {
              parts.push(itemText);
            }
          }
        }

        state.reporter.emit("Finalizing response");
        const result = parts.join("") || null;
        log.debug(`Prompt response received (${result?.length ?? 0} chars)`);
        return result;
      } catch (err) {
        log.debug(`Prompt failed: ${log.formatErrorChain(err)}`);
        throw err;
      } finally {
        state.onProgress = undefined;
        state.reporter = createProgressReporter();
        state.loadingReported = false;
      }
    },

    async send(sessionId: string, text: string): Promise<void> {
      const state = sessions.get(sessionId);
      if (!state) {
        throw new Error(`Codex session ${sessionId} not found`);
      }

      log.debug(
        `Codex provider does not support non-blocking send — ` +
        `agent.run() is blocking. Ignoring follow-up for session ${sessionId} ` +
        `(${text.length} chars).`,
      );
    },

    async cleanup(): Promise<void> {
      log.debug("Cleaning up Codex provider...");
      for (const state of sessions.values()) {
        try {
          state.agent.terminate();
        } catch {}
      }
      sessions.clear();
    },
  };
}
