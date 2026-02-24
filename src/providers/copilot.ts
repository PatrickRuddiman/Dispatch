/**
 * GitHub Copilot provider — wraps the @github/copilot-sdk to conform
 * to the generic ProviderInstance interface.
 *
 * Requires the `copilot` CLI to be installed and available on PATH
 * (or specify the path via COPILOT_CLI_PATH).
 *
 * Authentication options:
 *   - Logged-in Copilot CLI user (default)
 *   - COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env vars
 */

import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import type { ProviderInstance, ProviderBootOptions } from "../provider.js";

/**
 * Boot a Copilot provider instance — starts or connects to a Copilot CLI server.
 */
export async function boot(opts?: ProviderBootOptions): Promise<ProviderInstance> {
  const client = new CopilotClient({
    ...(opts?.url ? { cliUrl: opts.url } : {}),
  });

  await client.start();

  // Track live sessions for prompt routing and cleanup
  const sessions = new Map<string, CopilotSession>();

  return {
    name: "copilot",

    async createSession(): Promise<string> {
      const session = await client.createSession();
      sessions.set(session.sessionId, session);
      return session.sessionId;
    },

    async prompt(sessionId: string, text: string): Promise<string | null> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Copilot session ${sessionId} not found`);
      }

      const event = await session.sendAndWait({ prompt: text });

      // Extract response text from the completion event
      if (!event) return null;
      return event.data?.content ?? null;
    },

    async cleanup(): Promise<void> {
      // Destroy all active sessions before stopping the server
      const destroyOps = [...sessions.values()].map((s) =>
        s.destroy().catch(() => {})
      );
      await Promise.all(destroyOps);
      sessions.clear();

      await client.stop().catch(() => {});
    },
  };
}
