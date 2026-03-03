/**
 * Provider registry — maps provider names to their boot functions.
 *
 * To add a new agent backend:
 *   1. Create `src/providers/<name>.ts` exporting an async `boot()` function
 *   2. Import and register it in the `PROVIDERS` map below
 *   3. Add the name to the `ProviderName` union in `src/providers/interface.ts`
 */

import type { ProviderName, ProviderInstance, ProviderBootOptions } from "./interface.js";
import { boot as bootOpencode, listModels as listOpencodeModels } from "./opencode.js";
import { boot as bootCopilot, listModels as listCopilotModels } from "./copilot.js";
import { boot as bootClaude, listModels as listClaudeModels } from "./claude.js";
import { boot as bootCodex, listModels as listCodexModels } from "./codex.js";

type BootFn = (opts?: ProviderBootOptions) => Promise<ProviderInstance>;
type ListModelsFn = (opts?: ProviderBootOptions) => Promise<string[]>;

const PROVIDERS: Record<ProviderName, BootFn> = {
  opencode: bootOpencode,
  copilot: bootCopilot,
  claude: bootClaude,
  codex: bootCodex,
};

const LIST_MODELS: Record<ProviderName, ListModelsFn> = {
  opencode: listOpencodeModels,
  copilot: listCopilotModels,
  claude: listClaudeModels,
  codex: listCodexModels,
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

/**
 * List available models for a provider by name.
 *
 * Starts a temporary provider instance (or connects to an existing server),
 * fetches the model list, and tears down. Returns model IDs as strings.
 * Throws if the provider is unavailable (caller should handle gracefully).
 *
 * @throws if the provider name is not registered or the provider is unavailable.
 */
export async function listProviderModels(
  name: ProviderName,
  opts?: ProviderBootOptions
): Promise<string[]> {
  const fn = LIST_MODELS[name];
  if (!fn) {
    throw new Error(
      `Unknown provider "${name}". Available: ${PROVIDER_NAMES.join(", ")}`
    );
  }
  return fn(opts);
}

export type { ProviderName, ProviderInstance, ProviderBootOptions } from "./interface.js";
export { PROVIDER_BINARIES, checkProviderInstalled } from "./detect.js";
