/**
 * Agent registry — maps agent names to their boot functions.
 *
 * To add a new agent:
 *   1. Create `src/agents/<name>.ts` exporting an async `boot()` function
 *   2. Import and register it in the `AGENTS` map below
 *   3. Add the name to the `AgentName` union in `src/agents/interface.ts`
 */

import type { AgentName, Agent, AgentBootOptions } from "./interface.js";
import { boot as bootPlanner, type PlannerAgent } from "./planner.js";
import { boot as bootExecutor, type ExecutorAgent } from "./executor.js";
import { boot as bootSpec, type SpecAgent } from "./spec.js";
import { boot as bootCommit, type CommitAgent } from "./commit.js";

type BootFn = (opts: AgentBootOptions) => Promise<Agent>;

const AGENTS: Record<AgentName, BootFn> = {
  planner: bootPlanner,
  executor: bootExecutor,
  spec: bootSpec,
  commit: bootCommit,
};

/**
 * All registered agent names — useful for CLI help text and validation.
 */
export const AGENT_NAMES = Object.keys(AGENTS) as AgentName[];

/**
 * Boot an agent by name.
 *
 * @throws if the agent name is not registered.
 */
export async function bootAgent(
  name: AgentName,
  opts: AgentBootOptions
): Promise<Agent> {
  const bootFn = AGENTS[name];
  if (!bootFn) {
    throw new Error(
      `Unknown agent "${name}". Available: ${AGENT_NAMES.join(", ")}`
    );
  }
  return bootFn(opts);
}

/**
 * Type-safe boot functions for specific agent roles.
 * Prefer these over the generic `bootAgent()` when you know the role at compile time.
 */
export { bootPlanner, bootExecutor, bootSpec, bootCommit };
export type { PlannerAgent, ExecutorAgent, SpecAgent, CommitAgent };
export type { AgentName, Agent, AgentBootOptions } from "./interface.js";
