/**
 * OpenCode provider — wraps the @opencode-ai/sdk to conform to the
 * generic ProviderInstance interface.
 */

import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
  type TextPart,
} from "@opencode-ai/sdk";
import type { ProviderInstance, ProviderBootOptions } from "../provider.js";

/**
 * Boot an OpenCode instance — either connect to a running server
 * or start a new one.
 */
export async function boot(opts?: ProviderBootOptions): Promise<ProviderInstance> {
  let client: OpencodeClient;
  let stopServer: (() => void) | undefined;

  if (opts?.url) {
    client = createOpencodeClient({ baseUrl: opts.url });
  } else {
    const oc = await createOpencode();
    client = oc.client;
    stopServer = () => oc.server.close();
  }

  return {
    name: "opencode",

    async createSession(): Promise<string> {
      const { data: session } = await client.session.create();
      if (!session) {
        throw new Error("Failed to create OpenCode session");
      }
      return session.id;
    },

    async prompt(sessionId: string, text: string): Promise<string | null> {
      const { data: response, error } = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
        },
      });

      if (error) {
        throw new Error(`OpenCode prompt failed: ${JSON.stringify(error)}`);
      }

      if (!response) return null;

      // Extract text from response parts
      const textParts = response.parts.filter(
        (p: Part): p is TextPart => p.type === "text" && "text" in p
      );
      return textParts.map((p: TextPart) => p.text).join("\n") || null;
    },

    async cleanup(): Promise<void> {
      stopServer?.();
    },
  };
}
