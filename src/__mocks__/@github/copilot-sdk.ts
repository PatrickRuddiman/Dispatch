/**
 * Test stub for @github/copilot-sdk.
 *
 * The real package depends on vscode-jsonrpc/node which uses a CJS
 * require() that cannot be resolved under Vitest's ESM module loader.
 * This stub satisfies Vite's import analysis during test runs so that
 * any test file that transitively touches the provider registry does not
 * fail at module resolution time.
 */

import { vi } from "vitest";

export class CopilotClient {
  constructor(_opts?: unknown) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async listModels(): Promise<string[]> {
    return [];
  }
  createSession(_opts?: unknown): CopilotSession {
    return new CopilotSession();
  }
}

export class CopilotSession {
  async sendMessage(_msg: string): Promise<AsyncIterable<AssistantMessageEvent>> {
    return (async function* () {})();
  }
}

export interface AssistantMessageEvent {
  type: string;
  message?: { content: string };
}

export const approveAll = vi.fn();

export function defineTool(_opts: unknown): unknown {
  return {};
}
