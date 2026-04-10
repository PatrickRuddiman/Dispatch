/**
 * Skill interface — a stateless data object that defines WHAT to do
 * (prompt template + result parser) without coupling to a provider.
 *
 * The dispatcher handles execution: it calls `buildPrompt()` to get the
 * prompt, sends it to a provider, then calls `parseResult()` to process
 * the response.
 *
 * To add a new skill:
 *   1. Create `src/skills/<name>.ts`
 *   2. Export the skill object (e.g. `export const mySkill: Skill<...> = { ... }`)
 *   3. Register it in `src/skills/index.ts`
 *   4. Add the name to the `SkillName` union below
 */

export type SkillName = "planner" | "executor" | "spec" | "commit";

/**
 * A stateless skill definition. Skills define prompt construction and
 * result parsing but never interact with providers directly.
 *
 * @typeParam TInput - The runtime values needed to build the prompt
 * @typeParam TOutput - The parsed result type
 */
export interface Skill<TInput = unknown, TOutput = unknown> {
  /** Skill role identifier */
  readonly name: SkillName;

  /** Build the complete prompt from runtime inputs. */
  buildPrompt(input: TInput): string;

  /**
   * Parse/process the raw provider response into a typed result.
   * May be async (e.g. for file I/O in spec skill).
   * Throw to signal a parse failure — the dispatcher converts it to a SkillResult error.
   */
  parseResult(response: string | null, input: TInput): TOutput | Promise<TOutput>;
}
