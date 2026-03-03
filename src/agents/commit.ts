/**
 * Commit agent — analyzes branch changes and generates meaningful
 * conventional-commit-compliant commit messages, PR titles, and PR
 * descriptions.
 *
 * The commit agent inspects the diff between the current branch and its
 * base, understands the intent of the changes, and produces structured
 * output that follows the project's commit conventions.
 */

import type { Agent, AgentBootOptions } from "./interface.js";

/**
 * A booted commit agent that can analyze branch changes and generate
 * meaningful commit messages, PR titles, and PR descriptions.
 */
export interface CommitAgent extends Agent {}

/**
 * Boot a commit agent backed by the given provider.
 *
 * @throws if `opts.provider` is not supplied — the commit agent requires a
 *         provider to create sessions and send prompts.
 */
export async function boot(opts: AgentBootOptions): Promise<CommitAgent> {
  const { provider } = opts;

  if (!provider) {
    throw new Error("Commit agent requires a provider instance in boot options");
  }

  return {
    name: "commit",

    async cleanup(): Promise<void> {
      // Commit agent has no owned resources — provider lifecycle is managed externally
    },
  };
}
