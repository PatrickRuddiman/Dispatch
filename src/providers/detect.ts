/**
 * Provider authentication detection — checks whether each provider has
 * valid credentials configured.
 *
 * Replaces the old binary-detection approach since providers are now
 * bundled as dependencies (no external CLI binary required).
 */

import type { ProviderName } from "./interface.js";
import { PROVIDER_REGISTRY, type AuthStatus } from "./registry.js";

/**
 * Check whether a provider has valid authentication configured.
 *
 * Returns `true` if the provider is ready to use, `false` otherwise.
 * Never rejects.
 */
export async function checkProviderAuthenticated(
  name: ProviderName,
): Promise<boolean> {
  const meta = PROVIDER_REGISTRY[name];
  const status = await meta.checkAuth();
  return status.status === "authenticated";
}

/**
 * Get the detailed auth status for a provider.
 */
export async function getProviderAuthStatus(
  name: ProviderName,
): Promise<AuthStatus> {
  const meta = PROVIDER_REGISTRY[name];
  return meta.checkAuth();
}

/**
 * Get all authenticated provider names.
 */
export async function getAuthenticatedProviders(
  providers: readonly ProviderName[],
): Promise<ProviderName[]> {
  const results = await Promise.all(
    providers.map(async (name) => ({
      name,
      authenticated: await checkProviderAuthenticated(name),
    })),
  );
  return results.filter((r) => r.authenticated).map((r) => r.name);
}
