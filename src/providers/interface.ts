/**
 * Provider interface — abstracts the underlying AI agent runtime so that
 * new code agents (OpenCode, Copilot, Claude Code, etc.) can be added by
 * implementing a single interface.
 *
 * Each provider manages its own server lifecycle, session isolation, and
 * prompt/response serialization. The orchestrator interacts exclusively
 * through this contract.
 */

export type ProviderName = "opencode" | "copilot" | "claude" | "codex";

export interface ProviderProgressSnapshot {
  text: string;
}

/**
 * Options passed when booting a provider.
 */
export interface ProviderBootOptions {
  /** Connect to an already-running server at this URL instead of spawning one */
  url?: string;
  /** Working directory for the agent */
  cwd?: string;
  /**
   * Model to use, overriding the provider's default.
   * Format is provider-specific:
   *   - Copilot: bare model ID (e.g. "claude-sonnet-4-5")
   *   - OpenCode: "provider/model" (e.g. "anthropic/claude-sonnet-4")
   * When omitted the provider uses its auto-detected default.
   */
  model?: string;
}

export interface ProviderPromptOptions {
  onProgress?: (snapshot: ProviderProgressSnapshot) => void;
}

/**
 * A booted provider instance that can create sessions and send prompts.
 *
 * To add support for a new agent backend:
 *   1. Create `src/providers/<name>.ts`
 *   2. Export an async `boot` function that returns a `ProviderInstance`
 *   3. Register it in `src/providers/index.ts`
 */
export interface ProviderInstance {
  /** Human-readable provider name (e.g. "opencode", "copilot") */
  readonly name: string;

  /**
   * Full model identifier in "provider/model" format as reported by the
   * underlying AI backend (e.g. "anthropic/claude-sonnet-4"), if available.
   */
  readonly model?: string;

  /**
   * Create a new isolated session for a single task.
   * Returns an opaque session identifier.
   */
  createSession(): Promise<string>;

  /**
   * Send a prompt to an existing session and wait for the agent to finish.
   * Returns the agent's text response, or null if no response was produced.
   */
  prompt(
    sessionId: string,
    text: string,
    options?: ProviderPromptOptions,
  ): Promise<string | null>;

  /**
   * Inject a follow-up message into a running session without blocking
   * for a response. Used to send time-warning nudges to the agent.
   * Optional — providers that don't support mid-session messaging can omit this.
   */
  send?(sessionId: string, text: string): Promise<void>;

  /**
   * Tear down the provider — stop servers, release resources.
   * Safe to call multiple times.
   */
  cleanup(): Promise<void>;
}
