/**
 * Provider registry — maps provider names to their boot functions.
 *
 * To add a new agent backend:
 *   1. Create `src/providers/<name>.ts` exporting an async `boot()` function
 *   2. Import and register it in the `PROVIDERS` map below
 *   3. Add the name to the `ProviderName` union in `src/providers/interface.ts`
 */

import type { ProviderName, ProviderInstance, ProviderBootOptions } from "./interface.js";
import { boot as bootOpencode } from "./opencode.js";
import { boot as bootCopilot } from "./copilot.js";

type BootFn = (opts?: ProviderBootOptions) => Promise<ProviderInstance>;

const PROVIDERS: Record<ProviderName, BootFn> = {
  opencode: bootOpencode,
  copilot: bootCopilot,
};

/**
 * All registered provider names — useful for CLI help text and validation.
 */
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

/**
 * Boot a provider by name.
 *
 * @throws if the provider name is not registered.
 */
export async function bootProvider(
  name: ProviderName,
  opts?: ProviderBootOptions
): Promise<ProviderInstance> {
  const bootFn = PROVIDERS[name];
  if (!bootFn) {
    throw new Error(
      `Unknown provider "${name}". Available: ${PROVIDER_NAMES.join(", ")}`
    );
  }
  return bootFn(opts);
}

export type { ProviderName, ProviderInstance, ProviderBootOptions } from "./interface.js";
