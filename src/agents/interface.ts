/**
 * Agent interface — abstracts the different agent roles in the dispatch
 * pipeline so that new agent implementations can be added by conforming
 * to a common contract.
 *
 * Each agent manages its own lifecycle and interacts with a provider
 * instance to perform AI-driven work. The CLI and orchestrator interact
 * with agents exclusively through this contract.
 *
 * To add a new agent:
 *   1. Create `src/agents/<name>.ts`
 *   2. Export an async `boot` function that returns an `Agent`
 *   3. Register it in `src/agents/index.ts`
 *   4. Add the name to the `AgentName` union below
 */

import type { ProviderInstance } from "../providers/interface.js";

export type AgentName = "planner" | "executor" | "spec" | "commit";

/**
 * Options passed when booting any agent.
 *
 * Not all agents require a provider — the orchestrator boots its own,
 * while the planner and executor receive one from the orchestrator.
 * Agents that need a provider should validate its presence at boot time.
 */
export interface AgentBootOptions {
  /** Working directory */
  cwd: string;
  /** The AI provider instance this agent will use for sessions */
  provider?: ProviderInstance;
}

/**
 * Base interface that all agent implementations must satisfy.
 *
 * Specific agent roles extend this with their own methods (e.g. `plan()`,
 * `orchestrate()`). The base provides identity and lifecycle management.
 */
export interface Agent {
  /** Human-readable agent name (e.g. "planner", "executor") */
  readonly name: string;

  /**
   * Tear down the agent — release resources.
   * Safe to call multiple times.
   */
  cleanup(): Promise<void>;
}
