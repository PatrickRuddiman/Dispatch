/**
 * Test stub for @openai/codex.
 *
 * The real package is a CLI-only bundle without a library entry-point.
 * This stub satisfies Vite's import analysis during test runs so that
 * any test file that transitively touches the provider registry does not
 * fail at module resolution time.
 */

export class AgentLoop {
  constructor(_opts: unknown) {}
  async run(_messages: unknown[]): Promise<unknown[]> {
    return [];
  }
  terminate(): void {}
}
