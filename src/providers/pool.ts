/**
 * ProviderPool — a transparent failover wrapper that implements ProviderInstance.
 *
 * Agents receive a pool instead of a raw provider instance. The pool routes
 * requests to the cheapest available provider and automatically fails over
 * to alternatives when throttling is detected.
 *
 * Key design decisions:
 *   - Lazy boots: only the primary provider is booted upfront; fallbacks are
 *     booted on first failover to avoid wasting resources.
 *   - Cooldowns: throttled providers are skipped for a configurable period.
 *   - Session tracking: maps session IDs to owning instances so prompt()
 *     calls route correctly.
 *   - Single-entry pool: identical behavior to a bare ProviderInstance —
 *     zero overhead for users who don't configure fallbacks.
 */

import type { ProviderName, ProviderInstance, ProviderBootOptions, ProviderPromptOptions } from "./interface.js";
import { bootProvider } from "./index.js";
import { isThrottleError } from "./errors.js";
import { log } from "../helpers/logger.js";

/** A provider+model entry in the pool, ordered by priority. */
export interface PoolEntry {
  /** Provider name (e.g. "copilot", "claude") */
  provider: ProviderName;
  /** Model override in provider-specific format */
  model?: string;
  /** Lower = preferred (cheaper). Entries are tried in priority order. */
  priority: number;
}

/** Options for constructing a ProviderPool. */
export interface ProviderPoolOptions {
  /** Provider entries ordered by priority (cheapest first). */
  entries: PoolEntry[];
  /** Boot options shared by all providers (url, cwd). Model is per-entry. */
  bootOpts: Omit<ProviderBootOptions, "model">;
  /** How long (ms) to avoid a throttled provider. Default: 60000. */
  cooldownMs?: number;
}

/** Generate a deduplication key for a provider+model combo. */
function entryKey(provider: ProviderName, model?: string): string {
  return `${provider}:${model ?? "default"}`;
}

/**
 * A pool of providers that implements ProviderInstance with transparent failover.
 *
 * Agents use this exactly like a normal provider — they never know about
 * the pool or failover mechanics.
 */
export class ProviderPool implements ProviderInstance {
  readonly name: string;
  readonly model?: string;

  private instances = new Map<string, ProviderInstance>();
  private cooldowns = new Map<string, number>();
  private sessionOwner = new Map<string, { instance: ProviderInstance; key: string }>();
  private entries: PoolEntry[];
  private bootOpts: Omit<ProviderBootOptions, "model">;
  private cooldownMs: number;

  constructor(opts: ProviderPoolOptions) {
    if (opts.entries.length === 0) {
      throw new Error("ProviderPool requires at least one entry");
    }
    // Sort by priority (stable sort preserves insertion order for equal priorities)
    this.entries = [...opts.entries].sort((a, b) => a.priority - b.priority);
    this.bootOpts = opts.bootOpts;
    this.cooldownMs = opts.cooldownMs ?? 60_000;

    // Name and model reflect the primary (highest-priority) entry
    const primary = this.entries[0];
    this.name = primary.provider;
    this.model = primary.model;
  }

  /**
   * Get the best available provider instance (not cooled down).
   * Boots the provider lazily if not yet started.
   */
  private async getProvider(excludeKey?: string): Promise<{ instance: ProviderInstance; key: string }> {
    const now = Date.now();

    for (const entry of this.entries) {
      const key = entryKey(entry.provider, entry.model);

      // Skip if this is the excluded provider (the one that just failed)
      if (key === excludeKey) continue;

      // Skip if still in cooldown
      const cooldownUntil = this.cooldowns.get(key);
      if (cooldownUntil && now < cooldownUntil) continue;

      // Boot if not yet started
      if (!this.instances.has(key)) {
        log.debug(`Pool: booting ${entry.provider}${entry.model ? ` (${entry.model})` : ""}`);
        const instance = await bootProvider(entry.provider, {
          ...this.bootOpts,
          model: entry.model,
        });
        this.instances.set(key, instance);
      }

      return { instance: this.instances.get(key)!, key };
    }

    throw new Error("ProviderPool: all providers are throttled or unavailable");
  }

  /** Mark a provider as throttled — it will be skipped until cooldown expires. */
  private markThrottled(key: string): void {
    this.cooldowns.set(key, Date.now() + this.cooldownMs);
    log.debug(`Pool: marked ${key} as throttled for ${this.cooldownMs}ms`);
  }

  async createSession(): Promise<string> {
    const { instance, key } = await this.getProvider();
    const sessionId = await instance.createSession();
    this.sessionOwner.set(sessionId, { instance, key });
    return sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
    options?: ProviderPromptOptions,
  ): Promise<string | null> {
    const owner = this.sessionOwner.get(sessionId);
    if (!owner) {
      throw new Error(`ProviderPool: session "${sessionId}" not found`);
    }

    try {
      return await owner.instance.prompt(sessionId, text, options);
    } catch (err) {
      // Only failover on throttle errors — all other errors propagate normally
      if (!isThrottleError(err) || this.entries.length <= 1) {
        throw err;
      }

      log.debug(`Pool: throttle detected on ${owner.key}, failing over...`);
      this.markThrottled(owner.key);

      // Get next available provider (excluding the one that just failed)
      const fallback = await this.getProvider(owner.key);

      // Create a new session on the fallback and retry the prompt
      const newSessionId = await fallback.instance.createSession();
      // Remap the original session ID to the fallback so any future calls route correctly
      this.sessionOwner.set(sessionId, fallback);

      return fallback.instance.prompt(newSessionId, text, options);
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const owner = this.sessionOwner.get(sessionId);
    if (!owner) return;
    if (owner.instance.send) {
      await owner.instance.send(sessionId, text);
    }
  }

  async cleanup(): Promise<void> {
    const cleanups = [...this.instances.values()].map((i) => i.cleanup());
    await Promise.allSettled(cleanups);
    this.instances.clear();
    this.sessionOwner.clear();
    this.cooldowns.clear();
  }
}
