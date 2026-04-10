/**
 * Smart provider router — automatically selects the best provider for each
 * skill role based on task requirements, cost, and provider availability.
 *
 * Produces `PoolEntry[]` arrays for direct consumption by ProviderPool.
 */

import type { ProviderModelConfig } from "../config.js";
import type { SkillName } from "../skills/interface.js";
import type { ProviderName } from "./interface.js";
import type { PoolEntry } from "./pool.js";
import { PROVIDER_REGISTRY, type ProviderMeta } from "./registry.js";

/** Resolve model for a provider, preferring config overrides over registry defaults. */
function resolveModel(
  meta: ProviderMeta,
  isFast: boolean,
  overrides?: Partial<Record<ProviderName, ProviderModelConfig>>,
): string {
  const override = overrides?.[meta.name];
  if (isFast) return override?.fast ?? meta.defaultFastModel;
  return override?.strong ?? meta.defaultStrongModel;
}

/** Skill roles that need fast/cheap models. */
const FAST_ROLES: ReadonlySet<SkillName> = new Set(["planner", "commit"]);

/** Skill roles that need strong/capable models. */
const STRONG_ROLES: ReadonlySet<SkillName> = new Set(["executor", "spec"]);

/**
 * Route a skill role to a prioritized list of provider+model entries.
 *
 * The returned entries are ordered by preference (cheapest/best first)
 * and can be passed directly to `new ProviderPool({ entries })`.
 *
 * @param role - The skill role to route (planner, executor, spec, commit)
 * @param authenticatedProviders - Provider names that are installed and authenticated
 * @param forceProvider - Optional CLI override that forces a specific provider for all roles
 */
export function routeSkill(
  role: SkillName,
  authenticatedProviders: ProviderName[],
  forceProvider?: ProviderName,
  modelOverrides?: Partial<Record<ProviderName, ProviderModelConfig>>,
): PoolEntry[] {
  // CLI --provider override: use that provider for everything
  if (forceProvider) {
    const meta = PROVIDER_REGISTRY[forceProvider];
    const isFast = FAST_ROLES.has(role);
    return [
      {
        provider: forceProvider,
        model: resolveModel(meta, isFast, modelOverrides),
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
        model: resolveModel(meta, isFast, modelOverrides),
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
    model: resolveModel(meta, isFast, modelOverrides),
    priority: i,
  }));
}

/**
 * Route all skill roles at once, returning a map of role -> PoolEntry[].
 *
 * Convenience wrapper around `routeSkill()` for pipeline setup.
 */
export function routeAllSkills(
  authenticatedProviders: ProviderName[],
  forceProvider?: ProviderName,
  modelOverrides?: Partial<Record<ProviderName, ProviderModelConfig>>,
): Record<"planner" | "executor" | "commit", PoolEntry[]> {
  return {
    planner: routeSkill("planner", authenticatedProviders, forceProvider, modelOverrides),
    executor: routeSkill("executor", authenticatedProviders, forceProvider, modelOverrides),
    commit: routeSkill("commit", authenticatedProviders, forceProvider, modelOverrides),
  };
}
