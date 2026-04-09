/**
 * Smart provider router — automatically selects the best provider for each
 * agent role based on task requirements, cost, and provider availability.
 *
 * Replaces the manual `resolveAgentProviderConfig()` from config.ts.
 * Produces `PoolEntry[]` arrays for direct consumption by ProviderPool.
 */

import type { AgentName } from "../agents/interface.js";
import type { ProviderName } from "./interface.js";
import type { PoolEntry } from "./pool.js";
import { PROVIDER_REGISTRY, type ProviderMeta } from "./registry.js";

/** Agent roles that need fast/cheap models. */
const FAST_ROLES: ReadonlySet<AgentName> = new Set(["planner", "commit"]);

/** Agent roles that need strong/capable models. */
const STRONG_ROLES: ReadonlySet<AgentName> = new Set(["executor", "spec"]);

/**
 * Route an agent role to a prioritized list of provider+model entries.
 *
 * The returned entries are ordered by preference (cheapest/best first)
 * and can be passed directly to `new ProviderPool({ entries })`.
 *
 * @param role - The agent role to route (planner, executor, spec, commit)
 * @param authenticatedProviders - Provider names that are installed and authenticated
 * @param forceProvider - Optional CLI override that forces a specific provider for all roles
 */
export function routeAgent(
  role: AgentName,
  authenticatedProviders: ProviderName[],
  forceProvider?: ProviderName,
): PoolEntry[] {
  // CLI --provider override: use that provider for everything
  if (forceProvider) {
    const meta = PROVIDER_REGISTRY[forceProvider];
    const isFast = FAST_ROLES.has(role);
    return [
      {
        provider: forceProvider,
        model: isFast ? meta.defaultFastModel : meta.defaultStrongModel,
        priority: 0,
      },
    ];
  }

  if (authenticatedProviders.length === 0) {
    throw new Error(
      "No authenticated providers available. Run 'dispatch config' to set up providers.",
    );
  }

  // Single provider: use it for everything
  if (authenticatedProviders.length === 1) {
    const meta = PROVIDER_REGISTRY[authenticatedProviders[0]];
    const isFast = FAST_ROLES.has(role);
    return [
      {
        provider: meta.name,
        model: isFast ? meta.defaultFastModel : meta.defaultStrongModel,
        priority: 0,
      },
    ];
  }

  const isFast = FAST_ROLES.has(role);
  const metas = authenticatedProviders.map((name) => PROVIDER_REGISTRY[name]);

  // Score and sort providers for this role
  const scored = metas
    .map((meta) => ({
      meta,
      score: isFast ? meta.costScore.fast : meta.costScore.strong,
      // Prefer free tier for fast roles, prefer strong capability for strong roles
      tierBonus: isFast
        ? meta.tier === "free" ? -10 : 0
        : 0,
    }))
    .sort((a, b) => {
      // For fast roles: free tier first, then cheapest
      // For strong roles: lowest cost score = best value for strong capability
      const aTotal = a.score + a.tierBonus;
      const bTotal = b.score + b.tierBonus;
      return aTotal - bTotal;
    });

  return scored.map(({ meta }, i) => ({
    provider: meta.name,
    model: isFast ? meta.defaultFastModel : meta.defaultStrongModel,
    priority: i,
  }));
}

/**
 * Route all agent roles at once, returning a map of role -> PoolEntry[].
 *
 * Convenience wrapper around `routeAgent()` for pipeline setup.
 */
export function routeAllAgents(
  authenticatedProviders: ProviderName[],
  forceProvider?: ProviderName,
): Record<"planner" | "executor" | "commit", PoolEntry[]> {
  return {
    planner: routeAgent("planner", authenticatedProviders, forceProvider),
    executor: routeAgent("executor", authenticatedProviders, forceProvider),
    commit: routeAgent("commit", authenticatedProviders, forceProvider),
  };
}
