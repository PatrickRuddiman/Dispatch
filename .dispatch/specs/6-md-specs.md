# Markdown File Specs (#6)

> Allow `--spec` to accept a glob pattern pointing to local markdown files, generating specs in-place without requiring an issue tracker.

## Context

Dispatch is a TypeScript (ESM-only, Node 18+) CLI tool that orchestrates AI agents to implement tasks from markdown spec files. It has two main modes:

- **Dispatch mode** (`dispatch <glob>`) — reads markdown task files, plans, and dispatches work to AI agents.
- **Spec mode** (`dispatch --spec <ids>`) — fetches issues from GitHub or Azure DevOps by number, sends them to an AI agent that explores the codebase, and writes structured markdown spec files to disk.

The spec generation pipeline lives in `src/spec-generator.ts`. It exports `generateSpecs()` which accepts a `SpecOptions` object containing a comma-separated string of issue numbers. The function:

1. Parses the issue numbers string by splitting on commas.
2. Detects or validates the issue source (GitHub/Azure DevOps) via `src/issue-fetchers/index.ts`.
3. Fetches each issue using the platform's CLI tool, normalizing results to `IssueDetails` objects (defined in `src/issue-fetcher.ts`).
4. Boots an AI provider via `src/providers/index.ts`.
5. For each issue, calls `generateSingleSpec()` which builds a detailed prompt via `buildSpecPrompt()`, creates an AI session, and instructs the agent to write the spec file directly to disk.
6. Optionally pushes the generated spec content back to the issue tracker.
7. Returns a `SpecSummary` with counts and file paths.

The CLI entry point is `src/cli.ts`, which uses a hand-rolled argument parser (`parseArgs()`). The `--spec` flag's value is passed directly as `SpecOptions.issues`. The routing logic checks `args.spec` and calls `generateSpecs()` if present.

The `glob` npm package (v11) is already a runtime dependency, used in `src/agents/orchestrator.ts` for dispatch mode file resolution.

The `IssueDetails` interface has fields: `number`, `title`, `body`, `labels`, `state`, `url`, `comments`, `acceptanceCriteria`.

The `buildSpecPrompt()` function constructs a ~115-line prompt incorporating all `IssueDetails` fields — number, title, state, URL, labels, body, acceptance criteria, and comments.

## Why

Currently, `--spec` only accepts comma-separated issue numbers, requiring users to have issues filed in GitHub or Azure DevOps before generating specs. This creates friction for users who:

- Want to draft spec requirements locally in markdown before filing issues.
- Work with issue trackers not yet supported by Dispatch.
- Need to iterate on spec drafts without round-tripping through an issue tracker.
- Want to convert existing design documents or feature briefs into structured Dispatch spec files.

By accepting a glob pattern (e.g., `dispatch --spec "drafts/*.md"`), users can point `--spec` at local markdown files. The tool reads each file's content as the "issue description" and generates a structured spec in-place — overwriting the source file with the AI-generated output. This keeps the workflow simple: write a rough draft, run the command, get a polished spec.

## Approach

### Input detection (no new CLI flag)

The `--spec` value can be disambiguated automatically:

- **Issue numbers:** purely numeric digits and commas (e.g., `"42,43,44"`). Matches pattern `/^\d+(,\s*\d+)*$/`.
- **Glob/file patterns:** anything else — contains path separators, wildcards, `.md` extension, or other non-numeric characters (e.g., `"drafts/*.md"`, `"./my-spec.md"`).

This detection should be a small, well-named utility function (e.g., `isGlobPattern()` or `isFilePath()`) that can be unit-tested in isolation. The check should happen early — either in `cli.ts` before calling into the spec generator, or at the top of `generateSpecs()` to route between the two code paths.

### Glob-based spec generation

When a glob pattern is detected, the pipeline diverges from the issue-tracker path:

1. **Resolve the glob** to a list of absolute file paths using the existing `glob` npm dependency (same usage pattern as `src/agents/orchestrator.ts`).
2. **Read each file** using `readFile` from `node:fs/promises`.
3. **Construct lightweight `IssueDetails`-like objects** from the file content. The file's basename (without extension) serves as the title, the full file content serves as the body, and remaining fields (number, labels, state, url, comments, acceptanceCriteria) are filled with sensible defaults or empty values.
4. **Build the spec prompt** — reuse or adapt `buildSpecPrompt()`. The prompt needs a variant that works without issue-tracker metadata (no issue number, no URL, no state). A separate function or conditional branch within the existing function can handle this. The key constraint: the `outputPath` for the generated spec should be the **same path as the source file**, so the AI agent overwrites it in-place.
5. **Generate specs via the AI provider** — reuse `generateSingleSpec()` or a similar function. The core loop (create session, send prompt, verify file written) is the same.
6. **Skip issue-tracker operations** — no issue source detection, no fetching, no `fetcher.update()` call.

### Architecture integration

- The `SpecOptions` interface needs a way to represent the new input type. One clean approach: add an optional field for the raw glob input alongside the existing `issues` field, or make `issues` optional and add a `files` or `glob` field. The `generateSpecs()` function then branches based on which field is populated.
- An alternative approach is to create a dedicated `generateSpecsFromFiles()` function that shares the AI-provider and batch-concurrency logic but skips all issue-fetcher code. This avoids cluttering `generateSpecs()` with conditionals.
- The `buildSpecPrompt()` function currently accepts `IssueDetails`. For file-based specs, a variant prompt builder is needed that takes a file path and content string instead, since most `IssueDetails` fields are meaningless for local files. The prompt should still instruct the AI agent to explore the codebase and produce the same structured spec format.
- The `SpecSummary` return type can be reused as-is.

### Key design decisions

- **Overwrite in-place:** The source markdown file is overwritten with the generated spec. The `outputPath` passed to the prompt builder and `generateSingleSpec()` is the original file path, not a path under `--output-dir`. The `--output-dir` flag is ignored in glob mode.
- **No issue source required:** When glob mode is active, `--source`, `--org`, and `--project` flags are irrelevant and should be ignored (or warned about if provided).
- **Concurrency:** The same batch-parallel pattern used for issue-based generation applies to file-based generation.

## Integration Points

- **`src/cli.ts`** — the `parseArgs()` function and `main()` routing logic. The `--spec` flag already captures a string value; the routing in `main()` needs to detect whether the value is issue numbers or a glob, then call the appropriate generation function. The `HELP` string and examples need updating.
- **`src/spec-generator.ts`** — the `SpecOptions` interface, `generateSpecs()` function, `generateSingleSpec()`, and `buildSpecPrompt()`. This is the primary module to extend. The new glob-based path should share the AI provider boot/cleanup and batch concurrency patterns.
- **`src/issue-fetcher.ts`** — the `IssueDetails` interface is referenced by `buildSpecPrompt()`. The file-based path either needs to construct compatible `IssueDetails` objects or use a different prompt builder that doesn't require them.
- **`glob` npm package** — already a dependency (v11), already imported in `src/agents/orchestrator.ts`. Should be imported the same way in whatever module resolves file patterns.
- **`node:fs/promises`** — already used in `src/spec-generator.ts` for `mkdir` and `readFile`. Will also be needed to read source markdown files.
- **Vitest** — test framework (v4). Tests are co-located as `<module>.test.ts` files in `src/`. The new detection logic and any pure utility functions should have unit tests following the same patterns as `src/parser.test.ts`.
- **TypeScript strict mode** — all new code must pass `tsc --noEmit` with the existing `tsconfig.json`.
- **ESM-only** — all imports must use `.js` extensions in import paths (TypeScript ESM convention used throughout the project).

## Tasks

- [ ] **Add input-type detection utility** — Create a function (e.g., `isIssueNumbers(input: string): boolean`) that determines whether the `--spec` value is a comma-separated list of issue numbers or a glob/file pattern. This should be a pure function that can be unit-tested. Place it in `src/spec-generator.ts` or a small utility module. The regex should match strings that are only digits, commas, and whitespace.

- [ ] **Extend `SpecOptions` and routing in `generateSpecs()`** — Update the `SpecOptions` interface and `generateSpecs()` function to support the file-based path. When the input is detected as a glob pattern, the function should skip issue source detection and fetching, instead resolving files via `glob` and reading their content. Consider whether to branch within `generateSpecs()` or create a separate `generateSpecsFromFiles()` function — either approach is acceptable as long as the code remains clean and the AI provider boot/cleanup and batch concurrency patterns are reused.

- [ ] **Build a file-based spec prompt** — Create a variant of `buildSpecPrompt()` (or adapt it) that works with a file path and its markdown content instead of `IssueDetails`. The prompt should still instruct the AI agent to explore the codebase, understand the content as a feature/issue description, and write a structured spec to the same file path (overwriting it). The output format (sections: Context, Why, Approach, Integration Points, Tasks, References) must remain identical.

- [ ] **Implement the file-based generation loop** — Wire the glob resolution, file reading, prompt building, and `generateSingleSpec()` calls together in a batch-parallel loop matching the existing concurrency pattern. The output path for each file should be its original path (in-place overwrite). Skip `fetcher.update()` calls since there is no issue tracker. Return a `SpecSummary` with accurate counts and file paths.

- [ ] **Update CLI help text and routing** — Update the `HELP` string in `src/cli.ts` to document that `--spec` also accepts glob patterns for local markdown files. Add an example like `dispatch --spec "drafts/*.md"`. Update the `Spec options` section description. Ensure the routing in `main()` correctly passes the `--spec` value to the appropriate code path (the detection logic should be transparent to `main()` — it just calls `generateSpecs()` which handles both cases internally).

- [ ] **Add unit tests for the detection utility** — Write tests in a co-located test file (e.g., `src/spec-generator.test.ts`) covering the input-type detection function. Test cases should include: pure numeric (`"42"`), comma-separated numbers (`"1,2,3"`), numbers with spaces (`"1, 2, 3"`), glob patterns (`"*.md"`, `"drafts/*.md"`, `"./spec.md"`), relative paths (`"drafts/feature.md"`), and edge cases (empty string, single filename like `"spec.md"`). Follow the Vitest patterns used in `src/parser.test.ts`.

## References

- [Issue #6 — md specs](https://github.com/PatrickRuddiman/Dispatch/issues/6)
- [`glob` npm package documentation](https://github.com/isaacs/node-glob)
- Existing glob usage pattern: `src/agents/orchestrator.ts`
- Existing spec generation pipeline: `src/spec-generator.ts`
- CLI argument parsing: `src/cli.ts`
