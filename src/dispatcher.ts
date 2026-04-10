/**
 * Dispatcher — executes skills by sending their prompts to a provider
 * and processing the results. Each dispatch creates a fresh session
 * for context isolation.
 */

import type { Skill } from "./skills/interface.js";
import type { SkillResult } from "./skills/types.js";
import type { ProviderInstance, ProviderPromptOptions } from "./providers/interface.js";
import type { Task } from "./parser.js";
import { log } from "./helpers/logger.js";
import { fileLoggerStorage } from "./helpers/file-logger.js";
import { TimeoutError } from "./helpers/timeout.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface DispatchResult {
  task: Task;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Dispatch options
// ---------------------------------------------------------------------------

/** Configuration for two-phase timebox (warn then kill). */
export interface TimeboxConfig {
  /** Duration in ms before sending a warning message. */
  warnMs: number;
  /** Duration in ms after the warning before hard-killing the prompt. */
  killMs: number;
  /** Warning message sent to the provider mid-session. */
  warnMessage: string;
}

/** Options for the generic `dispatch()` function. */
export interface DispatchOptions {
  /** Provider prompt options (e.g. onProgress callback). */
  promptOptions?: ProviderPromptOptions;
  /** Two-phase timebox: warn then kill. */
  timebox?: TimeboxConfig;
}

// ---------------------------------------------------------------------------
// Generic dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a skill by sending its prompt to a provider and parsing the result.
 *
 * 1. Calls `skill.buildPrompt(input)` to construct the prompt
 * 2. Creates a fresh provider session
 * 3. Sends the prompt (optionally with timebox)
 * 4. Calls `skill.parseResult(response, input)` to process the output
 * 5. Wraps everything in a `SkillResult<TOutput>`
 */
export async function dispatch<TInput, TOutput>(
  skill: Skill<TInput, TOutput>,
  input: TInput,
  provider: ProviderInstance,
  options?: DispatchOptions,
): Promise<SkillResult<TOutput>> {
  const startTime = Date.now();
  try {
    const prompt = skill.buildPrompt(input);
    fileLoggerStorage.getStore()?.prompt(skill.name, prompt);

    const sessionId = await provider.createSession();
    log.debug(`[${skill.name}] Prompt built (${prompt.length} chars)`);

    let response: string | null;
    if (options?.timebox) {
      response = await promptWithTimebox(provider, sessionId, prompt, options.timebox, options.promptOptions);
    } else {
      response = await provider.prompt(sessionId, prompt, options?.promptOptions);
    }

    if (response) fileLoggerStorage.getStore()?.response(skill.name, response);

    const data = await skill.parseResult(response, input);

    fileLoggerStorage.getStore()?.skillEvent(skill.name, "completed", `${Date.now() - startTime}ms`);
    return { data, success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    const message = log.extractMessage(err);
    fileLoggerStorage.getStore()?.error(`${skill.name} error: ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
    return { data: null, success: false, error: message, durationMs: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------------------
// Timebox support
// ---------------------------------------------------------------------------

/**
 * Send a prompt with a two-phase timebox:
 *   1. After `warnMs`, send a warning message via `provider.send()`
 *   2. After an additional `killMs`, reject with a TimeoutError
 */
async function promptWithTimebox(
  provider: ProviderInstance,
  sessionId: string,
  prompt: string,
  timebox: TimeboxConfig,
  promptOptions?: ProviderPromptOptions,
): Promise<string | null> {
  const { warnMs, killMs, warnMessage } = timebox;

  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let warnTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (warnTimer) clearTimeout(warnTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    // Start the warn timer
    warnTimer = setTimeout(() => {
      if (settled) return;
      log.warn(`Timebox warn fired for session ${sessionId} — sending wrap-up message`);

      if (provider.send) {
        provider.send(sessionId, warnMessage).catch((err) => {
          log.warn(`Failed to send timebox warning: ${log.extractMessage(err)}`);
        });
      } else {
        log.warn(`Provider does not support send() — cannot deliver timebox warning`);
      }

      // Start the kill timer
      killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TimeoutError(warnMs + killMs, "dispatch timebox"));
      }, killMs);
    }, warnMs);

    // Run the prompt
    provider.prompt(sessionId, prompt, promptOptions).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}
