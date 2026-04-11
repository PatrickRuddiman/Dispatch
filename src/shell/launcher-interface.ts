/**
 * Shell launcher interface — shared types for provider-specific shell launchers.
 *
 * Each launcher spawns a provider's interactive CLI process with the Dispatch
 * MCP server injected via stdio, running in full-auto (no permission prompts) mode.
 */

import type { ChildProcess } from "node:child_process";
import type { ProviderName } from "../providers/interface.js";

/** Options passed to each shell launcher. */
export interface ShellLauncherOptions {
  /** Working directory for the provider CLI. */
  cwd: string;
  /** System prompt appended to the provider's default system prompt. */
  systemPrompt?: string;
  /** User's initial prompt (short, passed as positional arg where supported). */
  initialPrompt?: string;
  /** Model override for the provider. */
  model?: string;
}

/** Result returned by a shell launcher after spawning the provider process. */
export interface ShellLaunchResult {
  /** The spawned child process. */
  process: ChildProcess;
  /** Cleanup function — removes temp files, stops servers, etc. */
  cleanup: () => Promise<void>;
  /**
   * Whether the provider SDK can connect to the same server the CLI started.
   * When true, the supervisor boots the SDK and uses provider.send() for
   * heartbeats and push notifications. When false, relies on MCP logging
   * and the restart loop.
   */
  sdkBridgeable: boolean;
}

/** A function that launches a provider CLI as an interactive shell. */
export type ShellLauncher = (opts: ShellLauncherOptions) => Promise<ShellLaunchResult>;

/** Registry mapping provider names to their shell launchers. */
export type ShellLauncherRegistry = Partial<Record<ProviderName, ShellLauncher>>;
