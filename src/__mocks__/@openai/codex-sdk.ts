/**
 * Test stub for @openai/codex-sdk.
 *
 * This stub satisfies Vite's import analysis during test runs so that
 * any test file that transitively touches the provider registry does not
 * fail at module resolution time.
 */

export class Thread {
  async run(_input: unknown): Promise<{ items: unknown[]; finalResponse: string; usage: null }> {
    return { items: [], finalResponse: "", usage: null };
  }
  async runStreamed(_input: unknown): Promise<{ events: AsyncGenerator<unknown> }> {
    return { events: (async function* () {})() };
  }
}

export class Codex {
  startThread(_options?: unknown): Thread {
    return new Thread();
  }
  resumeThread(_id: string, _options?: unknown): Thread {
    return new Thread();
  }
}
