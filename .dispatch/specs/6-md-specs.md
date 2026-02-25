# Markdown File Specs (#6)

> Allow `--spec` to accept a glob pattern pointing to local markdown files, generating specs in-place without requiring an issue tracker.

## Context

Dispatch is a TypeScript (ESM-only, Node 18+) CLI tool that orchestrates AI agents to implement tasks from markdown spec files. It is built with `tsup`, tested with Vitest v4, and uses strict TypeScript with the `bundler` module resolution strategy. All import paths use the `.js` extension convention required by ESM.

The project has two main modes:

- **Dispatch mode** (`dispatch <glob>`) — reads markdown task files, plans, and dispatches work to AI agents.
- **Spec mode** (`dispatch --spec <ids>`) — fetches issues from GitHub or Azure DevOps by number, sends them to an AI agent that explores the codebase, and writes structured markdown spec files to disk.

### Key modules involved

- **`src/cli.ts`** — CLI entry point with a hand-rolled `parseArgs()` function and `main()` routing logic. The `--spec` flag captures a string value which is passed directly as `SpecOptions.issues`. The `HELP` string documents all options and examples. The `CliArgs` interface has `spec?: string` along with `issueSource`, `org`, `project`, and `outputDir` fields for spec mode.

- **`src/spec-generator.ts`** — The spec generation pipeline. Exports `SpecOptions` (interface with `issues: string` and optional fields for issue source, provider, concurrency, output directory, etc.), `SpecSummary` (counts and file paths), and `generateSpecs()` (the main entry function). Internally contains `generateSingleSpec()` (creates AI session, sends prompt, verifies file written) and `buildSpecPrompt()` (constructs a ~130-line prompt from `IssueDetails`). The function uses a batch-parallel pattern with `Promise.all` and `splice` for concurrency-limited processing.

- **`src/issue-fetcher.ts`** — Defines the `IssueDetails` interface (`number`, `title`, `body`, `labels`, `state`, `url`, `comments`, `acceptanceCriteria`), `IssueFetchOptions`, and the `IssueFetcher` interface.

- **`src/issue-fetchers/index.ts`** — Registry of issue fetchers, `detectIssueSource()` function, and `ISSUE_SOURCE_NAMES` constant.

- **`src/agents/orchestrator.ts`** — Contains the existing `glob` import pattern: `import { glob } from "glob"` with options `{ cwd, absolute: true }`.

- **`src/parser.test.ts`** — 995-line co-located test file demonstrating Vitest conventions: `describe`/`it`/`expect`, `afterEach` cleanup, `const FILE = "/fake/tasks.md"` for pure tests, `mkdtemp`/`rm` for I/O tests, imports from `./parser.js`.

### Dependencies already available

- `glob` v11 — runtime dependency, already imported in `src/agents/orchestrator.ts`
- `node:fs/promises` — already used in `src/spec-generator.ts` for `mkdir` and `readFile`
- `node:path` — already used for `join` in `src/spec-generator.ts`

## Why

Currently, `--spec` only accepts comma-separated issue numbers, requiring users to have issues filed in GitHub or Azure DevOps before generating specs. This creates friction for users who:

- Want to draft spec requirements locally in markdown before filing issues.
- Work with issue trackers not yet supported by Dispatch.
- Need to iterate on spec drafts without round-tripping through an issue tracker.
- Want to convert existing design documents or feature briefs into structured Dispatch spec files.

By accepting a glob pattern (e.g., `dispatch --spec "drafts/*.md"`), users can point `--spec` at local markdown files. The tool reads each file's content as the "issue description" and generates a structured spec in-place — overwriting the source file with the AI-generated output. This keeps the workflow simple: write a rough draft, run the command, get a polished spec.

## Approach

### Input detection — no new CLI flag

The `--spec` value is disambiguated automatically using a pure utility function:

- **Issue numbers:** the string matches `/^\d+(,\s*\d+)*$/` — only digits, commas, and optional whitespace (e.g., `"42"`, `"1,2,3"`, `"1, 2, 3"`).
- **Glob/file patterns:** anything that does not match the above regex — contains path separators, wildcards, `.md` extension, alphabetic characters, etc. (e.g., `"drafts/*.md"`, `"./my-spec.md"`, `"spec.md"`).

This detection function (e.g., `isIssueNumbers(input: string): boolean`) should be exported from `src/spec-generator.ts` so it can be unit-tested. It is called at the top of `generateSpecs()` to route between the two code paths, keeping `main()` in `cli.ts` unchanged — it just calls `generateSpecs()` with the `--spec` value as before.

### Two code paths within the spec generator

The `SpecOptions` interface is updated to make `issues` optional and add an optional `glob` field (or the existing `issues` field is reused since the detection happens inside `generateSpecs()`). The cleanest approach: keep the `issues` field as the sole input string, and let `generateSpecs()` internally detect which mode to use.

When the input is detected as a glob pattern, `generateSpecs()` delegates to a new internal function (e.g., `generateSpecsFromFiles()`) that:

1. **Resolves the glob** using the `glob` package with `{ cwd, absolute: true }` — the same pattern used in `src/agents/orchestrator.ts`.
2. **Reads each file** using `readFile` from `node:fs/promises`.
3. **Builds a file-specific prompt** using a new `buildFileSpecPrompt()` function (or an adapted variant of `buildSpecPrompt()`) that accepts a file path and its content string rather than `IssueDetails`. The prompt uses the file's basename (without extension) as the title and the file's full content as the description. It omits issue-tracker metadata (number, URL, state, labels) but retains the same output format instructions and spec structure requirements.
4. **Generates specs** by calling `generateSingleSpec()` (or a variant that accepts a prompt string directly) for each file. The `outputPath` is the **same path as the source file** — overwriting it in-place.
5. **Skips all issue-tracker operations** — no `detectIssueSource()`, no `fetcher.fetch()`, no `fetcher.update()`.
6. **Uses the same batch-parallel concurrency pattern** (splice-based queue with `Promise.all` batches).
7. **Returns a `SpecSummary`** with accurate totals.

### Adapting `generateSingleSpec()`

The current `generateSingleSpec()` is tightly coupled to `IssueDetails` because it calls `buildSpecPrompt(issue, cwd, outputPath)` internally. Two options:

- **Option A:** Make `generateSingleSpec()` accept a pre-built prompt string instead of (or in addition to) an `IssueDetails` object, so both code paths can use it. This is cleaner.
- **Option B:** Create a parallel `generateSingleSpecFromFile()` that duplicates the session-create/prompt/verify logic. This is simpler but duplicates code.

Option A is preferred — refactor `generateSingleSpec()` to accept `(instance, prompt, outputPath)` and have both the issue-based and file-based paths build their prompts externally before calling it.

### File-based prompt builder

A new `buildFileSpecPrompt(filePath: string, content: string, cwd: string)` function constructs a prompt similar to `buildSpecPrompt()` but:

- Uses the filename (basename without `.md`) as the title/identifier instead of issue number.
- Uses the file content as the description/body instead of `IssueDetails.body`.
- Omits issue-specific metadata sections (number, state, URL, labels, acceptance criteria, comments).
- Uses the source file path as the `outputPath` (in-place overwrite).
- Retains the identical output format specification (sections: `# Title`, `> Summary`, `## Context`, `## Why`, `## Approach`, `## Integration Points`, `## Tasks`, `## References`, `## Key Guidelines`).
- Retains the identical instructions (explore codebase, understand the content, research approach, identify integration points, DO NOT make code changes).
- Retains the `(P)`/`(S)` task tagging instructions.

### Key design decisions

- **Overwrite in-place:** The source markdown file is overwritten with the generated spec. The `--output-dir` flag is ignored in file/glob mode.
- **No issue source required:** When glob mode is active, `--source`, `--org`, and `--project` flags are irrelevant and silently ignored.
- **Concurrency:** The same batch-parallel pattern applies. The default concurrency calculation (`min(cpuCount, freeMB/500)`) is reused.
- **Empty glob results:** If the glob resolves to zero files, log an error and return an empty `SpecSummary` (matching the pattern for zero issue numbers).

## Integration Points

- **`src/spec-generator.ts`** — Primary module to extend. The `SpecOptions` interface, `generateSpecs()` routing, `generateSingleSpec()` signature, and a new `buildFileSpecPrompt()` function. Must maintain the existing `buildSpecPrompt()` for the issue-based path. The batch concurrency pattern (splice-queue + `Promise.all`) must be reused.

- **`src/cli.ts`** — The `HELP` string needs updated descriptions and examples for glob-based spec generation. The `main()` routing logic should remain unchanged since `generateSpecs()` handles detection internally. The `--spec` option description in HELP should note it accepts both issue numbers and glob patterns.

- **`src/issue-fetcher.ts`** — The `IssueDetails` interface is not modified. The file-based path avoids constructing `IssueDetails` objects entirely, using a dedicated prompt builder instead.

- **`glob` npm package** — Import using the same pattern as `src/agents/orchestrator.ts`: `import { glob } from "glob"` with options `{ cwd, absolute: true }`.

- **`node:fs/promises`** — Already imported in `src/spec-generator.ts`. Use `readFile` to read source markdown files.

- **`node:path`** — Already imported. Use `basename` (with extension stripping) to derive titles from filenames.

- **Vitest** — Co-located test file `src/spec-generator.test.ts`. Follow patterns from `src/parser.test.ts`: `describe`/`it`/`expect` blocks, imports with `.js` extension, `const`-based test fixtures, descriptive test names.

- **TypeScript strict mode** — All new code must compile under `tsc --noEmit` with the existing `tsconfig.json`. No `any` types.

- **ESM conventions** — All imports must use `.js` extensions (e.g., `import { ... } from "./spec-generator.js"`).

## Tasks

- [x] (S) **Add input-type detection utility** — Create and export a pure function `isIssueNumbers(input: string): boolean` in `src/spec-generator.ts` that returns `true` when the input string consists solely of digits, commas, and whitespace (matching the pattern for comma-separated issue numbers). Everything else is treated as a glob/file pattern. This function is the branching point for the two spec-generation code paths and must be testable in isolation.

- [x] (P) **Add unit tests for the detection utility** — Create `src/spec-generator.test.ts` with a `describe("isIssueNumbers")` block covering: pure numeric strings (`"42"`, `"1,2,3"`, `"1, 2, 3"`), glob patterns (`"*.md"`, `"drafts/*.md"`, `"./spec.md"`), relative file paths (`"drafts/feature.md"`), plain filenames (`"spec.md"`), edge cases (empty string, whitespace-only string), and strings with mixed content (`"42,foo"`). Follow the Vitest patterns from `src/parser.test.ts`.

- [x] (S) **Build a file-based spec prompt function** — Create a `buildFileSpecPrompt(filePath: string, content: string, cwd: string)` function in `src/spec-generator.ts` that constructs the same style of spec-agent prompt as `buildSpecPrompt()` but uses the file path and its content instead of `IssueDetails`. The filename (basename minus extension) serves as the title. The file content serves as the description. The output path is the same as the input file path (in-place overwrite). The output format instructions, spec structure template, `(P)`/`(S)` tagging rules, and agent guidelines must be identical to those in `buildSpecPrompt()`.

- [ ] (S) **Refactor `generateSingleSpec()` to accept a prompt string** — Change `generateSingleSpec()` so it accepts a pre-built prompt string and an output path (instead of building the prompt internally from `IssueDetails`). Update the existing issue-based call site in `generateSpecs()` to build the prompt externally via `buildSpecPrompt()` and pass it in. This decouples the function from `IssueDetails` so both code paths can reuse it.

- [ ] (S) **Implement the file-based generation path in `generateSpecs()`** — Add a branch at the top of `generateSpecs()` that calls `isIssueNumbers()` on the `issues` input. When it returns `false`, delegate to a new internal function (e.g., `generateSpecsFromFiles()`) that: resolves the glob with `{ cwd, absolute: true }`, reads each file, builds prompts via `buildFileSpecPrompt()`, generates specs via the refactored `generateSingleSpec()`, and returns a `SpecSummary`. Reuse the AI provider boot/cleanup and the splice-based batch concurrency pattern. Skip all issue-fetcher operations. Log appropriate messages for empty glob results and per-file progress.

- [ ] (P) **Update CLI help text** — Update the `HELP` string in `src/cli.ts` to document that `--spec` accepts both comma-separated issue numbers and glob patterns for local markdown files. Update the `Spec options` section description for `--spec` to mention both input types. Add an example like `dispatch --spec "drafts/*.md"` to the examples list.

## References

- [Issue #6 — md specs](https://github.com/PatrickRuddiman/Dispatch/issues/6)
- [`glob` npm package documentation](https://github.com/isaacs/node-glob)
- Existing glob usage pattern: `src/agents/orchestrator.ts`
- Existing spec generation pipeline: `src/spec-generator.ts`
- CLI argument parsing: `src/cli.ts`
- Issue details interface: `src/issue-fetcher.ts`
- Test conventions: `src/parser.test.ts`
