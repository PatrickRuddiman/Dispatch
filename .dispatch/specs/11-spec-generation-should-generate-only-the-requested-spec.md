# Spec generation should generate only the requested spec (#11)

> Add post-processing, validation, and prompt hardening to the spec generation pipeline so that AI-written spec files contain only the structured spec content — no preamble, summaries, code fences, or conversational text.

## Context

This project is `dispatch-tasks`, a TypeScript (ESM-only, Node >= 18) CLI tool that orchestrates AI coding agents. The build system uses `tsup`, tests use Vitest (co-located `*.test.ts` files in `src/`), and source modules use `.js` extensions in imports.

The spec generation pipeline lives in `src/spec-generator.ts`. When a user runs `dispatch --spec 42,43`, the pipeline:

1. Fetches issue details from a tracker (GitHub or Azure DevOps) via `src/issue-fetchers/`
2. Boots an AI provider (`src/providers/`) and creates a session per issue
3. Sends a prompt built by `buildSpecPrompt()` instructing the AI agent to explore the codebase and write a spec file to a given path using its Write tool
4. Verifies the file exists on disk via `readFile()` — but performs **no content validation or post-processing**

The AI agent writes the file directly to disk during its session. The `response` returned by `instance.prompt()` is the agent's conversational reply (e.g., "The spec file has been written to..."), which is logged but not written to disk. However, the agent's Write tool call is what actually creates the file, and AI agents sometimes write incorrect content — preamble, summaries, code-fence wrapping, or conversational text instead of (or in addition to) the structured spec.

Evidence of this problem exists in `.dispatch/specs/`:
- `6-md-specs.md` — contains AI conversational summary, not a spec
- `9-dont-commit-in-execute-each-task.md` — same problem
- `10-all-spec-generation-should-be-parralell.md` — a stale duplicate; the AI wrote two files: this conversational summary AND the actual spec at the correctly-spelled filename
- `11-spec-generation-should-generate-only-the-requested-spec.md` — the current issue's spec file also contains conversational summary rather than structured spec content

The expected spec structure (defined in `buildSpecPrompt()`) is:
- `# <title> (#<number>)` — H1 heading
- `> <summary>` — blockquote
- `## Context`, `## Why`, `## Approach`, `## Integration Points`, `## Tasks`, `## References` — H2 sections
- `- [ ]` task checkboxes in the Tasks section

Key files involved:
- `src/spec-generator.ts` — the pipeline: `generateSpecs()`, `generateSingleSpec()`, `buildSpecPrompt()`
- `src/provider.ts` — `ProviderInstance` interface (defines `prompt()` returning `string | null`)
- `src/parser.ts` — existing markdown parsing utilities (for pattern reference)
- `src/parser.test.ts` — the only existing test file (607 lines, 32 test cases; establishes all testing conventions)
- `src/logger.ts` — logging utilities used throughout

## Why

The spec generator has no defense against malformed AI output. When the AI agent writes a file, it may include:

1. **Preamble text** before the spec — e.g., "The spec file has been written to..." or "Here's the spec:" or other conversational openers
2. **Postamble summaries** after the spec — e.g., "Here's a summary of what the spec covers..."
3. **Code-fence wrapping** — the entire spec wrapped in ` ```markdown ... ``` `
4. **Wrong content entirely** — a conversational summary instead of the structured spec

This has caused real problems: issue #10's spec generation produced a stale duplicate file containing only a conversational summary. Multiple other spec files in `.dispatch/specs/` contain summaries rather than specs.

Since the pipeline reads the file back after generation (to push it to the issue tracker via `fetcher.update()`), corrupted content also gets pushed to GitHub issues.

Adding post-processing and validation ensures that:
- Spec files contain only the expected structured content
- The pipeline catches and warns about malformed output
- The prompt is hardened to reduce the likelihood of bad output in the first place

## Approach

Implement three layers of defense, applied in order after the AI agent writes the spec file to disk:

### Layer 1: Content extraction function

Create an `extractSpecContent()` function in `src/spec-generator.ts` that post-processes the raw file content after the AI writes it. This function should:

- Strip code-fence wrapping (` ```markdown ... ``` ` or ` ``` ... ``` `) if the entire content is wrapped
- Remove preamble text before the first `# ` (H1) heading — AI agents often prepend conversational text before the actual spec
- Remove postamble text after the spec's structural content ends — detect the end of the last expected section and trim everything after it
- Handle edge cases: content that is already clean (pass through unchanged), content with no recognizable spec structure (return as-is with a warning)

This function should be pure (string in, string out) for easy testing, following the same pattern as `parseTaskContent()` in `src/parser.ts`.

### Layer 2: Structural validation

Create a `validateSpecStructure()` function that checks the cleaned content for the expected structural markers:
- Must start with an H1 heading (`# `)
- Must contain a `## Tasks` section with at least one `- [ ]` checkbox

If validation fails, log a warning but do not fail the pipeline — the file is still written (it may still be useful even if imperfect). This is a guardrail, not a gate.

### Layer 3: Prompt strengthening

Tighten the `buildSpecPrompt()` instructions to explicitly prohibit common failure modes. Add clear, direct instructions at both the beginning and end of the prompt that the file must contain ONLY the spec content — no preamble, no summary, no code fences, no conversational text.

### Integration into the pipeline

After the AI agent writes the file and the pipeline verifies it exists, add a new step in `generateSingleSpec()` that:
1. Reads the file content
2. Runs it through `extractSpecContent()`
3. Runs it through `validateSpecStructure()`
4. Writes the cleaned content back to disk (only if it changed)

This happens before the `fetcher.update()` call in `generateSpecs()`, so the cleaned content is what gets pushed to the issue tracker.

## Integration Points

- **`src/spec-generator.ts`** — all new functions (`extractSpecContent`, `validateSpecStructure`) live here; `generateSingleSpec()` gains the post-processing step; `buildSpecPrompt()` gets prompt hardening
- **`src/spec-generator.test.ts`** — new co-located test file following the conventions established in `src/parser.test.ts`: Vitest with `describe`/`it`/`expect`, pure function tests using inline string data, no mocking, imports with `.js` extension
- **`src/logger.ts`** — use existing `log.warn()` and `log.debug()` for validation warnings
- **`src/provider.ts`** — no changes needed; the `ProviderInstance.prompt()` return value is already handled correctly (it's logged but not written to disk)
- **Vitest** — tests run via `npm test` (`vitest run`); no config file needed (Vitest auto-discovers `*.test.ts`)
- **TypeScript strict mode** — all new code must satisfy `tsc --noEmit` with strict checks enabled
- **ESM conventions** — use `.js` extensions in import paths, `node:` prefix for Node.js built-ins

## Tasks

- [ ] Create the `extractSpecContent()` pure function in `src/spec-generator.ts` — takes a raw string, strips code-fence wrapping, removes preamble before the first H1 heading, and removes postamble after the last recognized spec section. Returns the cleaned string. Must handle already-clean content as a no-op.

- [ ] Create the `validateSpecStructure()` function in `src/spec-generator.ts` — takes a string and checks for the expected structural markers (H1 heading, `## Tasks` section with `- [ ]` items). Returns a result indicating whether the structure is valid with a reason if not. Uses `log.warn()` to surface issues without failing the pipeline.

- [ ] Integrate post-processing into `generateSingleSpec()` — after verifying the file exists, read it back, run it through `extractSpecContent()`, validate with `validateSpecStructure()`, and write the cleaned content back to disk if it changed. This must happen before the function returns, so that `generateSpecs()` reads clean content for the `fetcher.update()` call.

- [ ] Strengthen the `buildSpecPrompt()` instructions — add explicit prohibitions against preamble, postamble, summaries, code-fence wrapping, and conversational text. Place these instructions prominently (near the top and reiterated near the output section) so they are hard for the AI agent to miss.

- [ ] Add unit tests in `src/spec-generator.test.ts` for `extractSpecContent()` — cover: already-clean content (no-op), code-fence-wrapped content, content with preamble before H1, content with postamble summary, content with both preamble and postamble, content with no recognizable structure (returned as-is). Follow conventions from `src/parser.test.ts` (Vitest, `describe`/`it`/`expect`, pure function tests, no mocking).

- [ ] Add unit tests in `src/spec-generator.test.ts` for `validateSpecStructure()` — cover: valid spec structure, missing H1, missing Tasks section, missing checkboxes, empty content. Follow same testing conventions.

## References

- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/11
- Related issue (caused the problem): https://github.com/PatrickRuddiman/Dispatch/issues/10
- Examples of corrupted spec files: `.dispatch/specs/6-md-specs.md`, `.dispatch/specs/9-dont-commit-in-execute-each-task.md`, `.dispatch/specs/10-all-spec-generation-should-be-parralell.md`
- Existing test conventions: `src/parser.test.ts`
- Spec generation pipeline: `src/spec-generator.ts`
