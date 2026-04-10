/**
 * Provider metadata registry — centralized source of truth for each provider's
 * characteristics, authentication requirements, and routing metadata.
 *
 * Used by the smart router to select providers per agent role, and by the
 * config wizard to walk users through auth setup.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderName } from "./interface.js";

const exec = promisify(execFile);

/** Timeout (ms) for auth probe commands. */
const AUTH_PROBE_TIMEOUT_MS = 10_000;

/** Authentication status for a provider. */
export type AuthStatus =
  | { status: "authenticated" }
  | { status: "not-configured"; hint: string }
  | { status: "expired"; hint: string };

/** Provider tier — determines cost and access characteristics. */
export type ProviderTier = "free" | "api-key";

/** Static metadata for a provider, used for routing and auth. */
export interface ProviderMeta {
  name: ProviderName;
  displayName: string;
  tier: ProviderTier;
  /** Default model for strong/capable tasks (executor, spec). */
  defaultStrongModel: string;
  /** Default model for fast/cheap tasks (planner, commit). */
  defaultFastModel: string;
  /** Relative cost scores (1 = cheapest, 10 = most expensive). */
  costScore: { strong: number; fast: number };
  /** Check whether auth credentials are available. */
  checkAuth: () => Promise<AuthStatus>;
}

// ── Auth check implementations ──────────────────────────────────

async function checkCopilotAuth(): Promise<AuthStatus> {
  // Check environment variables first
  if (
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN
  ) {
    return { status: "authenticated" };
  }
  // Fall back to copilot CLI auth status, then gh CLI
  try {
    await exec("copilot", ["auth", "status"], { timeout: AUTH_PROBE_TIMEOUT_MS });
    return { status: "authenticated" };
  } catch {
    // Try gh CLI as a secondary fallback
    try {
      await exec("gh", ["auth", "status"], { timeout: AUTH_PROBE_TIMEOUT_MS });
      return { status: "authenticated" };
    } catch {
      return {
        status: "not-configured",
        hint: "Run 'copilot login' or set GITHUB_TOKEN",
      };
    }
  }
}

async function checkClaudeAuth(): Promise<AuthStatus> {
  if (process.env.ANTHROPIC_API_KEY) {
    return { status: "authenticated" };
  }
  // Try claude CLI auth check
  try {
    await exec("claude", ["auth", "status"], { timeout: AUTH_PROBE_TIMEOUT_MS });
    return { status: "authenticated" };
  } catch {
    return {
      status: "not-configured",
      hint: "Run 'claude auth login' or set ANTHROPIC_API_KEY",
    };
  }
}

async function checkCodexAuth(): Promise<AuthStatus> {
  if (process.env.OPENAI_API_KEY) {
    return { status: "authenticated" };
  }
  // Try codex CLI auth check
  try {
    await exec("codex", ["login", "status"], { timeout: AUTH_PROBE_TIMEOUT_MS });
    return { status: "authenticated" };
  } catch {
    return {
      status: "not-configured",
      hint: "Run 'codex login --device-auth' or set OPENAI_API_KEY",
    };
  }
}

async function checkOpencodeAuth(): Promise<AuthStatus> {
  // Check if the binary exists
  try {
    await exec("opencode", ["--version"], { timeout: AUTH_PROBE_TIMEOUT_MS });
  } catch {
    return {
      status: "not-configured",
      hint: "Install OpenCode (https://opencode.ai)",
    };
  }
  // Try opencode CLI auth check
  try {
    await exec("opencode", ["auth", "list"], { timeout: AUTH_PROBE_TIMEOUT_MS });
    return { status: "authenticated" };
  } catch {
    return {
      status: "not-configured",
      hint: "Run 'opencode auth login' or set provider API keys",
    };
  }
}

// ── Registry ────────────────────────────────────────────────────

export const PROVIDER_REGISTRY: Record<ProviderName, ProviderMeta> = {
  copilot: {
    name: "copilot",
    displayName: "GitHub Copilot",
    tier: "free",
    defaultStrongModel: "claude-sonnet-4-5",
    defaultFastModel: "claude-haiku-4",
    costScore: { strong: 1, fast: 1 },
    checkAuth: checkCopilotAuth,
  },
  claude: {
    name: "claude",
    displayName: "Claude Code",
    tier: "api-key",
    defaultStrongModel: "claude-sonnet-4",
    defaultFastModel: "claude-haiku-3-5",
    costScore: { strong: 5, fast: 2 },
    checkAuth: checkClaudeAuth,
  },
  codex: {
    name: "codex",
    displayName: "OpenAI Codex",
    tier: "api-key",
    defaultStrongModel: "o4-mini",
    defaultFastModel: "codex-mini-latest",
    costScore: { strong: 4, fast: 1 },
    checkAuth: checkCodexAuth,
  },
  opencode: {
    name: "opencode",
    displayName: "OpenCode",
    tier: "api-key",
    defaultStrongModel: "anthropic/claude-sonnet-4",
    defaultFastModel: "anthropic/claude-haiku-3-5",
    costScore: { strong: 5, fast: 3 },
    checkAuth: checkOpencodeAuth,
  },
};

/**
 * Get metadata for all providers, with current auth status.
 */
export async function getProviderStatuses(): Promise<
  Array<ProviderMeta & { authStatus: AuthStatus }>
> {
  const entries = Object.values(PROVIDER_REGISTRY);
  const statuses = await Promise.all(entries.map((e) => e.checkAuth()));
  return entries.map((entry, i) => ({ ...entry, authStatus: statuses[i] }));
}
