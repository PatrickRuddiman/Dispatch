# Spec generation should generate only the requested spec (#11)

> Add post-processing, validation, and prompt hardening to the spec generation pipeline so that AI-written spec files contain only the structured spec content — no preamble, summaries, code fences, or conversational text.

## Context

This project is `dispatch-tasks`, a TypeScript (ESM-only, Node >= 18) CLI tool that orchestrates AI coding agents. The build system uses `tsup`, tests use Vitest (co-located `*.test.ts` files in `src/`), and all source imports use `.js` extensions. TypeScript strict mode is enforced (`tsc --noEmit`).

The spec generation pipeline lives in `src/spec-generator.ts` and contains three key functions:

- **`generateSpecs()`** — the top-level entry point. Fetches issues in parallel batches, boots an AI provider, generates specs in parallel batches, then pushes cleaned spec content back to the issue tracker via `fetcher.update()`.
- **`generateSingleSpec()`** — creates an AI session, sends the prompt, and verifies the file exists on disk. Currently performs no content validation or post-processing after the file is verified.
- **`buildSpecPrompt()`** — assembles the prompt that instructs the AI agent to explore the codebase and write the spec file. Defines the expected markdown structure (H1 title, blockquote summary, H2 sections: Context, Why, Approach, Integration Points, Tasks, References).

The AI agent writes the spec file directly to disk during its session via its Write tool. The `response` from `instance.prompt()` is the agent's conversational reply (e.g., "The spec file has been written to...") — it is logged but not written to disk. The problem is that the agent's Write tool call sometimes writes incorrect content to the file.

Other key files:
- `src/provider.ts` — defines the `ProviderInstance` interface (`prompt()` returns `string | null`)
- `src/parser.ts` — existing markdown parsing utilities with pure functions like `parseTaskContent()` (string in, structured data out) — a pattern to follow for new extraction/validation functions
- `src/parser.test.ts` — the only existing test file (995 lines, ~32 test cases); establishes all testing conventions
- `src/logger.ts` — provides `log.info()`, `log.success()`, `log.warn()`, `log.error()`, `log.debug()`, and `log.formatErrorChain()`

Evidence of the corruption problem exists in `.dispatch/specs/`:
- `10-all-spec-generation-should-be-parralell.md` — contains only an AI conversational summary ("The spec file has been written to..."), not a structured spec. This is the canonical example of the problem.

## Why

The spec generator has no defense against malformed AI output. When the AI agent writes a file via its Write tool, it may produce:

1. **Preamble text** before the spec — conversational openers like "Here's the spec:" or "I've written the spec file to..."
2. **Postamble summaries** after the spec — concluding text like "Here's a summary of what the spec covers..."
3. **Code-fence wrapping** — the entire spec wrapped in ` ```markdown ... ``` `
4. **Wrong content entirely** — a conversational summary instead of the structured spec

Since the pipeline reads the file back after generation to push it to the issue tracker via `fetcher.update()`, corrupted content also gets pushed to GitHub issues, compounding the problem.

Adding three layers of defense — content extraction, structural validation, and prompt hardening — ensures that:
- Spec files contain only the expected structured content
- The pipeline catches and warns about malformed output
- The prompt itself reduces the likelihood of bad output in the first place

## Approach

Implement three layers of defense, applied in order after the AI agent writes the spec file to disk:

### Layer 1: Content extraction (`extractSpecContent`)

Create a pure function that post-processes the raw file content. It should:
- Strip code-fence wrapping (` ```markdown ... ``` ` or ` ``` ... ``` `) if the entire content appears to be wrapped in a code fence
- Remove preamble text before the first `# ` (H1) heading — this catches conversational text the AI prepends
- Remove postamble text after the spec's structural content ends — detect the last recognized H2 section's content and trim everything after it
- Pass through already-clean content unchanged (no-op)
- Return content as-is (with a warning logged) when no recognizable spec structure is found — do not destroy potentially useful content

This function must be pure (string in, string out) for testability, following the same design pattern as `parseTaskContent()` in `src/parser.ts`.

### Layer 2: Structural validation (`validateSpecStructure`)

Create a function that checks the cleaned content for expected structural markers:
- Must start with an H1 heading (`# `)
- Must contain a `## Tasks` section with at least one `- [ ]` checkbox

If validation fails, log a warning via `log.warn()` but do NOT fail the pipeline — the file is still written. This is a guardrail, not a gate. The function should return a structured result (valid/invalid with reason) so callers can act on it.

### Layer 3: Prompt strengthening

Tighten `buildSpecPrompt()` to explicitly prohibit common failure modes. Add clear instructions at both the beginning of the prompt (near the role definition) and near the output section that the file must contain ONLY the structured spec content — no preamble, no summary, no code fences, no conversational text. Reiterate near the Write tool instruction that the file content must begin with `# ` and contain nothing else.

### Pipeline integration

Modify `generateSingleSpec()` to add a post-processing step after verifying the file exists:
1. Read the file content (the existing `readFile` call can be reused/extended rather than discarded)
2. Run it through `extractSpecContent()`
3. Run it through `validateSpecStructure()`
4. Write the cleaned content back to disk only if it actually changed

This must happen before `generateSingleSpec()` returns, so that the subsequent `fetcher.update()` call in `generateSpecs()` reads clean content. The current code flow in `generateSpecs()` already reads the file after `generateSingleSpec()` completes, so the post-processing naturally slots in.

Both new functions (`extractSpecContent` and `validateSpecStructure`) must be exported from `src/spec-generator.ts` so they can be imported and tested in the co-located test file.

## Integration Points

- **`src/spec-generator.ts`** — all new logic lives here. `extractSpecContent()` and `validateSpecStructure()` are new exported functions. `generateSingleSpec()` gains a post-processing step. `buildSpecPrompt()` gets prompt hardening additions. No new files are needed in `src/` except the test file.

- **`src/spec-generator.test.ts`** — new co-located test file. Must follow conventions from `src/parser.test.ts`:
  - Import from `vitest` (`describe`, `it`, `expect`)
  - Import with `.js` extension (`./spec-generator.js`)
  - Pure function tests using inline string data — no mocking, no I/O
  - `describe` blocks per function, `it` blocks per case
  - Use `toMatchObject`, `toBe`, `toEqual` assertions as appropriate

- **`src/logger.ts`** — use `log.warn()` for validation warnings and `log.debug()` for post-processing details. No changes to logger.ts itself.

- **`src/provider.ts`** — no changes needed. The `ProviderInstance.prompt()` return value is already handled correctly.

- **Build/test commands** — `npm test` (`vitest run`) to run tests, `npm run typecheck` (`tsc --noEmit`) to verify type safety. Both must pass.

- **ESM conventions** — `.js` extensions in all import paths, `node:` prefix for Node.js built-ins (`node:fs/promises`).

- **`writeFile` from `node:fs/promises`** — needs to be imported in `src/spec-generator.ts` (currently only `readFile` and `mkdir` are imported) for writing back cleaned content.

## Tasks

- [ ] (P) Create the `extractSpecContent()` pure function in `src/spec-generator.ts` — takes a raw string, strips code-fence wrapping, removes preamble before the first H1 heading, and removes postamble after the last recognized spec section. Returns the cleaned string. Must handle already-clean content as a no-op and return unrecognizable content as-is. Export it for testing.

- [x] (P) Create the `validateSpecStructure()` function in `src/spec-generator.ts` — takes a string and checks for the expected structural markers (H1 heading at the start, `## Tasks` section with at least one `- [ ]` checkbox). Returns a structured result indicating whether the structure is valid with a reason if not. Uses `log.warn()` to surface issues. Export it for testing.

- [x] (S) Integrate post-processing into `generateSingleSpec()` — after verifying the file exists, read the content, run it through `extractSpecContent()`, validate with `validateSpecStructure()`, and write the cleaned content back to disk if it changed. Add `writeFile` to the imports from `node:fs/promises`. This must complete before `generateSingleSpec()` returns so the downstream `fetcher.update()` call in `generateSpecs()` reads clean content.

- [ ] (P) Strengthen the `buildSpecPrompt()` instructions — add explicit prohibitions against preamble, postamble, summaries, code-fence wrapping, and conversational text. Place these instructions near the role definition at the top of the prompt AND reiterate them near the Write tool / output section so they frame both the beginning and end of the AI agent's attention window.

- [ ] (P) Add unit tests in `src/spec-generator.test.ts` for `extractSpecContent()` — cover: already-clean content (no-op), code-fence-wrapped content, content with preamble before H1, content with postamble summary, content with both preamble and postamble, content with no recognizable structure (returned as-is). Follow conventions from `src/parser.test.ts`.

- [ ] (P) Add unit tests in `src/spec-generator.test.ts` for `validateSpecStructure()` — cover: valid spec structure, missing H1, missing Tasks section, missing checkboxes, empty content. Follow same testing conventions.

## References

- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/11
- Related issue (caused the problem): https://github.com/PatrickRuddiman/Dispatch/issues/10
- Canonical corrupted spec file: `.dispatch/specs/10-all-spec-generation-should-be-parralell.md`
- Existing test conventions: `src/parser.test.ts`
- Spec generation pipeline: `src/spec-generator.ts`
- Parser pure function pattern: `src/parser.ts` (`parseTaskContent()`)
- Logger utilities: `src/logger.ts`
