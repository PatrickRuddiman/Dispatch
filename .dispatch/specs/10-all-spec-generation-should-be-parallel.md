# All spec generation should be parallel (#10)

> Parallelize spec generation so multiple issues are processed concurrently, and add post-generation steps to push spec content back to GitHub issues and close them upon task completion.

## Context

This project is `dispatch-tasks`, a TypeScript (ESM-only, Node >= 18) CLI tool that orchestrates AI agents to convert issue tracker items into implementation specs and then dispatch those specs as coding tasks. The build system uses `tsup`, tests use `Vitest`, and the project follows conventional commit conventions.

The spec generation pipeline lives in `src/spec-generator.ts` and is invoked from `src/cli.ts` when the `--spec` flag is provided. It:
1. Parses comma-separated issue numbers
2. Detects the issue source (GitHub or Azure DevOps) via `src/issue-fetchers/index.ts`
3. Fetches each issue sequentially using the appropriate fetcher (`src/issue-fetchers/github.ts` or `src/issue-fetchers/azdevops.ts`)
4. Boots a single AI provider instance (`src/providers/index.ts`)
5. Generates each spec sequentially by prompting the AI via `generateSingleSpec()`
6. Writes each spec to `.dispatch/specs/<id>-<slug>.md`

Both the issue-fetching loop (lines 109–121) and the spec-generation loop (lines 140–166) are sequential `for` loops with `await` inside — no concurrency at all.

The dispatch mode (orchestrator in `src/agents/orchestrator.ts`) already implements a batch-concurrency pattern using `Promise.all` with a configurable `--concurrency` flag, which serves as the project's existing precedent for parallel work.

The GitHub issue fetcher in `src/issue-fetchers/github.ts` shells out to the `gh` CLI for reading issues. The `gh` CLI also supports `gh issue edit` (to update title/body) and `gh issue close` — but neither is currently used anywhere in the codebase.

The `src/issue-fetcher.ts` interface (`IssueFetcher`) currently only defines a `fetch()` method. There is no `update()` or `close()` method.

## Why

**Parallelization:** When a user runs `dispatch --spec 42,43,44,45,46`, each spec requires an independent AI session that may take minutes. Running them sequentially means total wall-clock time scales linearly with the number of issues. Since each spec generation is fully independent (separate AI sessions, separate output files, no shared mutable state), they are naturally parallelizable. The dispatch mode already supports concurrency — spec mode should too.

**Push specs back to GitHub:** After generating a spec, the issue's title and description in the tracker should be updated with the spec content. This makes the spec visible directly on the issue without requiring manual copy-paste. The issue description explicitly calls this a "procedural step, not an AI step" — it should be a deterministic operation using the `gh` CLI (or equivalent), not an AI prompt.

**Close issues upon completion:** When all tasks in a spec are completed (via the dispatch pipeline), the originating issue should be closed automatically. Again, this is a procedural step — a `gh issue close` (or equivalent) call, not an AI decision.

## Approach

### 1. Parallelize spec generation

Adopt the same batch-concurrency pattern used by the orchestrator: splice a queue into batches of size N, process each batch with `Promise.all`, then move to the next batch. Both the issue-fetching phase and the spec-generation phase should be parallelized.

The existing `--concurrency` CLI flag should be reused in spec mode (it currently only affects dispatch mode). This avoids adding a new flag and keeps the CLI interface consistent.

### 2. Push spec content back to GitHub issues

After each spec file is successfully generated and written to disk, update the originating issue on the tracker. For GitHub, this means calling `gh issue edit <number> --body <spec-content>` from within the spec generator. The title may also be updated to match the spec's H1 heading if it differs.

This should be implemented as a new method on the `IssueFetcher` interface (e.g., `update()`) so that each tracker backend can implement it in its own way (GitHub uses `gh`, Azure DevOps uses `az boards`). The spec generator calls this method after writing the file — it is a procedural/deterministic step, not AI-driven.

### 3. Close issues upon task completion

After the dispatch pipeline completes all tasks from a spec file, the originating issue should be closed. This requires:
- Knowing which issue number a spec file originated from (the ID is already encoded in the filename pattern `<id>-<slug>.md`)
- A new `close()` method on the `IssueFetcher` interface
- The orchestrator (or a post-dispatch hook in the CLI) calling the close method after all tasks in an issue's spec are completed

This is also a procedural step — deterministic CLI calls, no AI involvement.

## Integration Points

- **`src/spec-generator.ts`** — the `generateSpecs()` function must be refactored from sequential loops to batch-concurrent `Promise.all` for both fetching and generation phases
- **`src/cli.ts`** — the `--concurrency` flag must be wired into spec mode (currently only passed to orchestrator), and a new `--concurrency` default or the existing one reused
- **`SpecOptions` interface** in `src/spec-generator.ts` — needs a `concurrency` field
- **`IssueFetcher` interface** in `src/issue-fetcher.ts` — needs `update()` and `close()` methods added
- **`src/issue-fetchers/github.ts`** — implement `update()` using `gh issue edit` and `close()` using `gh issue close`
- **`src/issue-fetchers/azdevops.ts`** — implement `update()` and `close()` using the `az boards` CLI (or mark as not-yet-implemented with a clear error)
- **`src/agents/orchestrator.ts`** — after all tasks from a spec file complete, call the issue close method
- **`src/parser.ts`** — may need a utility to extract the issue number from a spec filename
- **Existing patterns:** The `execFile`/`promisify` pattern used in `git.ts` and `github.ts` for shelling out to CLI tools; the batch-splice-`Promise.all` pattern in `orchestrator.ts` for concurrency; the logger (`src/logger.ts`) conventions for info/success/error/debug messages

## Tasks

- [x] Add `concurrency` field to `SpecOptions` interface in `src/spec-generator.ts` and wire it through from `src/cli.ts` using the existing `--concurrency` CLI flag
- [x] Refactor the issue-fetching loop in `generateSpecs()` to use batch-concurrent `Promise.all`, matching the splice-queue pattern from the orchestrator
- [x] Refactor the spec-generation loop in `generateSpecs()` to use batch-concurrent `Promise.all`, processing multiple specs in parallel with the configured concurrency
- [x] Add an optional `update()` method to the `IssueFetcher` interface in `src/issue-fetcher.ts` for pushing content back to an issue's title and body
- [x] Implement `update()` in `src/issue-fetchers/github.ts` using `gh issue edit <id> --title <title> --body <body>`
- [x] Implement `update()` in `src/issue-fetchers/azdevops.ts` using the appropriate `az boards` CLI command (or a clear not-implemented error)
- [x] Call `fetcher.update()` from `generateSpecs()` after each spec is successfully written to disk, pushing the generated spec content back as the issue body
- [x] Add an optional `close()` method to the `IssueFetcher` interface in `src/issue-fetcher.ts` for closing/resolving issues
- [x] Implement `close()` in `src/issue-fetchers/github.ts` using `gh issue close <id>`
- [x] Implement `close()` in `src/issue-fetchers/azdevops.ts` using the appropriate `az boards` CLI command (or a clear not-implemented error)
- [x] Add post-completion issue-closing logic — after the dispatch pipeline finishes all tasks from a spec file, extract the issue number from the spec filename and call `fetcher.close()` to close the originating issue
- [x] Update logging in `src/spec-generator.ts` to reflect parallel execution (e.g., log batch progress, concurrent task counts) using the existing logger conventions

## References

- GitHub CLI `gh issue edit` docs: https://cli.github.com/manual/gh_issue_edit
- GitHub CLI `gh issue close` docs: https://cli.github.com/manual/gh_issue_close
- Existing concurrency pattern: `src/agents/orchestrator.ts` (batch-splice with `Promise.all`)
- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/10
