# Dispatch Behavioral Audit

**Date:** 2026-04-09  
**Method:** Spec-unaware source code read — no documentation consulted during audit  
**Coverage:** All source files under `src/`

Gap classifications:
- `MISSING_IMPL` — behavior documented/expected but not implemented
- `WRONG_IMPL` — implementation differs from what a reader would expect
- `UNDOCUMENTED` — behavior present in code with no docs coverage
- `DOCS_STALE` — docs describe behavior that no longer matches code

---

## CLI & Config

**Files:** `src/cli.ts`, `src/config.ts`, `src/config-prompts.ts`, `src/constants.ts`, `src/orchestrator/cli-config.ts`

### Behaviors

- Two subcommands (`config`, `mcp`) are handled via raw `process.argv[2]` inspection **before** Commander parses flags — Commander never sees them.
- MCP server supports two transports: stdio (default) and HTTP (`--http` flag, default port `9110`, host `127.0.0.1`).
- 30+ CLI flags with explicit validation bounds.
- `--provider` defaults to `"opencode"` in `parseArgs` but must be **explicitly user-supplied** to satisfy the mandatory provider check in `resolveCliConfig`. The default `"opencode"` value does not pass the check because the check is run on the raw un-merged config before the default is applied.
- An `explicitFlags` Set tracks which flags the user actually typed (vs. defaults) — used for three-tier config merge logic.
- `nextIssueId` is present in `DispatchConfig` but absent from `CONFIG_KEYS` — it is internal-only and cannot be set via CLI or wizard.

### Gaps

| # | Classification | Finding |
|---|---|---|
| 1 | `WRONG_IMPL` | Config wizard (`config-prompts.ts`) only writes back the fields it prompts for. Fields like `testTimeout`, `planTimeout`, `concurrency`, and `username` are silently dropped if a user runs the wizard after having set them manually. A save from the wizard will delete those fields from the config file. |
| 2 | `WRONG_IMPL` | Provider check in `resolveCliConfig` runs on the raw un-merged config. The `"opencode"` CLI default is applied to `parseArgs` output, but the check fires before merging — so an un-configured provider always fails even when the default would satisfy it. |
| 3 | `UNDOCUMENTED` | `explicitFlags` Set exists and drives three-tier config merge precedence. The merge logic itself is non-obvious. |

---

## Orchestrator Pipelines

**Files:** `src/orchestrator/runner.ts`, `src/orchestrator/dispatch-pipeline.ts`, `src/orchestrator/spec-pipeline.ts`, `src/orchestrator/fix-tests-pipeline.ts`, `src/orchestrator/datasource-helpers.ts`

### Behaviors

**Dispatch pipeline — 7 phases:**
1. Discovery (fetch issues from datasource)
2. Temp file writing (`writeItemsToTempDir`)
3. Worktree decision
4. Provider boot
5. Feature branch setup
6. Per-issue processing (plan → execute → commit)
7. Feature branch finalization (PR creation)

**Worktree creation condition:** `!noWorktree && (feature || (!noBranch && tasksByFile.size > 1))`  
Single-issue runs never use worktrees unless `--feature` is set.

**Spec pipeline:** Renames the output file based on the H1 heading content (re-slugifies) and performs an atomic rename.

**Fix-tests pipeline:** Detects test failures, invokes an AI agent to fix them.

**Temp directories** created by `writeItemsToTempDir` are never explicitly deleted — cleanup is left to the OS.

### Gaps

| # | Classification | Finding |
|---|---|---|
| 4 | `WRONG_IMPL` | `testTimeout` is computed in the fix-tests pipeline but **never used** — it is a dead variable. Neither test run is wrapped with any timeout. |
| 5 | `WRONG_IMPL` | Fix-tests pipeline makes exactly **one AI attempt** regardless of the `resolvedRetries` value. No retry loop exists. |
| 6 | `WRONG_IMPL` | `buildPrTitle` in `datasource-helpers.ts` takes the "last" element of the `git log` array. Because `git log` returns newest-first, the "last" element is the **oldest** commit in the branch — likely producing a poor PR title. |
| 7 | `UNDOCUMENTED` | `upsertResult` deduplication: on retry, the earlier failed result is overwritten in both the local and global results arrays. Only the most recent attempt is retained. |
| 8 | `UNDOCUMENTED` | Temp directories from `writeItemsToTempDir` are never cleaned up by Dispatch — relies entirely on OS temp cleanup. |

---

## Agents & Providers

**Files:** `src/agents/planner.ts`, `src/agents/executor.ts`, `src/agents/commit.ts`, `src/agents/spec.ts`, `src/providers/opencode.ts`, `src/providers/copilot.ts`, `src/providers/claude.ts`, `src/providers/codex.ts`, `src/providers/detect.ts`, `src/providers/pool.ts`, `src/providers/progress.ts`

### Behaviors

- Planner prompt instructs the AI to produce output "as a system prompt in second person" — the entire response becomes the executor's plan.
- Commit instruction is controlled by a regex `/\bcommit\b/i` on the task text — tasks containing the word "commit" trigger a git commit; others forbid it.
- Rate-limit detection in `dispatcher.ts` uses 4 regex patterns applied to response text even when the HTTP call itself succeeded (i.e., rate limits surfaced in response bodies).
- OpenCode provider spawns the server but **cannot pass `cwd`** — the server inherits `process.cwd()`, not the task's working directory. Correct cwd is conveyed via prompt context only.
- Provider pool: on throttle error, remaps the original session ID to the fallback session — future calls on the original ID transparently route to the fallback.

### Gaps

| # | Classification | Finding |
|---|---|---|
| 9 | `WRONG_IMPL` | Commit agent fails if **both** `commitMessage` and `prTitle` are empty. A response that contains only one of the two still passes — the validation only requires at least one to be non-empty. This is likely not the intended behavior. |
| 10 | `WRONG_IMPL` | `Codex.send()` is a **no-op** — it logs a debug message and returns without doing anything. The spec agent's warn-phase message is silently ignored for Codex users. |
| 11 | `UNDOCUMENTED` | OpenCode cannot receive a `cwd` from the caller at spawn time. The working directory is communicated to the AI only through the prompt text, not the process environment. |
| 12 | `UNDOCUMENTED` | `Claude.close()` wraps `session.close()` in `Promise.resolve()` because the underlying method may or may not return a Promise depending on the version. |

---

## Datasources

**Files:** `src/datasources/github.ts`, `src/datasources/azdevops.ts`, `src/datasources/md.ts`, `src/datasources/index.ts`

### Behaviors

- All three datasources implement `buildBranchName(title, number)` but **ignore `title` entirely** — branch name is always `{username}/dispatch/issue-{number}`.
- GitHub datasource re-runs `git remote get-url origin` as a subprocess on **every API call** — no caching.
- Azure DevOps `doneStateCache` is a module-level Map (process-lifetime) that is never evicted.
- Azure DevOps PR creation links to the work item via `workItemRefs`; GitHub does not.
- MD datasource `getUsername` falls back to `"local"`; GitHub and Azure fall back to `"unknown"`.

### Gaps

| # | Classification | Finding |
|---|---|---|
| 13 | `WRONG_IMPL` | `buildBranchName` accepts a `title` parameter in all three datasources but ignores it completely. Branch names never include the issue title. |
| 14 | `WRONG_IMPL` | `deriveShortUsername` is copy-pasted identically across all three datasource files — no shared helper. |
| 15 | `WRONG_IMPL` | GitHub `getOwnerRepo()` runs a `git remote get-url origin` subprocess on every invocation. For a run with many API calls this is significant unnecessary overhead. |
| 16 | `WRONG_IMPL` | MD datasource `list()` silently returns `[]` if the specs directory does not exist; `fetch()` throws if the file does not exist. Inconsistent error handling for missing resources. |
| 17 | `WRONG_IMPL` | MD datasource `nextIssueId` has no concurrency protection. Two simultaneous `create()` calls will produce duplicate IDs. |
| 18 | `UNDOCUMENTED` | MD datasource `update()` ignores the `title` argument — only `body` is written back. Title changes are silently dropped. |
| 19 | `UNDOCUMENTED` | Azure DevOps `doneStateCache` is never evicted. A long-running process or a state change in ADO will serve stale data for the lifetime of the process. |

---

## Parser & Spec Generator

**Files:** `src/parser.ts`, `src/spec-generator.ts`, `src/test-runner.ts`

### Behaviors

- Default task mode when no `(P)`/`(S)`/`(I)` prefix is present is `"serial"`, not `"parallel"`.
- `markTaskComplete` re-reads the file from disk on every call; throws if the line is already checked.
- `validateSpecStructure` failures are warnings only — they do not block execution.
- `extractSpecContent` recognizes exactly 7 H2 section names for postamble trimming; any other H2 heading after the last recognized one is silently discarded.
- `defaultConcurrency()` formula: `Math.max(1, Math.min(cpus().length, Math.floor(freemem() / 1024 / 1024 / 500)))` — CPU count capped by available memory (500 MB per worker).

### Gaps

| # | Classification | Finding |
|---|---|---|
| 20 | `WRONG_IMPL` | `detectTestCommand` in `test-runner.ts` always returns the hardcoded string `"npm test"` regardless of what is actually in `package.json` scripts. |
| 21 | `WRONG_IMPL` | `CHECKED_RE` is defined in `parser.ts` but **never called** in any function body — it is an unused constant. |
| 22 | `UNDOCUMENTED` | `extractSpecContent` silently discards any H2 content that follows an unrecognized section heading. Authors adding custom H2 sections after recognized ones will lose that content. |
| 23 | `UNDOCUMENTED` | `defaultConcurrency()` is memory-gated, not just CPU-gated. On memory-constrained machines the effective concurrency may be 1 regardless of CPU count. |

---

## Helpers & Utilities

**Files:** `src/helpers/cleanup.ts`, `src/helpers/worktree.ts`, `src/helpers/run-state.ts`, `src/helpers/retry.ts`, `src/helpers/concurrency.ts`, `src/helpers/branch-validation.ts`, `src/helpers/file-logger.ts`, `src/helpers/prereqs.ts`, `src/helpers/auth.ts`, `src/helpers/format.ts`, `src/helpers/slugify.ts`, `src/helpers/timeout.ts`, `src/helpers/logger.ts`, `src/helpers/environment.ts`, `src/helpers/errors.ts`, `src/helpers/guards.ts`, `src/helpers/gitignore.ts`, `src/helpers/confirm-large-batch.ts`, `src/tui.ts`, `src/dispatcher.ts`

### Behaviors

- `runCleanup()` uses `splice(0)` to drain the handlers array before executing — provides re-entrant safety.
- Worktree creation: 5-retry exponential backoff (200ms base, doubling) with error type discrimination.
- `withRetry`: **no delay between attempts** — retries are immediate.
- `run-state.ts`: SQLite-backed, JSON migration on first call per cwd, `shouldSkipTask` only skips tasks with status `"success"` (not `"failed"` or other statuses).
- Branch validation: 7 rules, max 255 chars, allowlist `/^[a-zA-Z0-9._\-/]+$/`.
- TUI: 80ms animation interval, in-place overwrite via cursor-up + Erase-to-EOL, groups display by worktree when >1 unique worktrees are active.
- `FileLogger.close()` is a no-op; all writes use `appendFileSync` (synchronous).
- `log.verbose` is implemented as a `defineProperty` getter/setter, not a plain boolean field.
- `environment.ts`: only 3 OS cases — `win32`, `darwin`, everything else is treated as Linux.
- `confirmLargeBatch` prompts the user when issue count exceeds 100.

### Gaps

| # | Classification | Finding |
|---|---|---|
| 24 | `WRONG_IMPL` | `withRetry` has no backoff delay between attempts. On transient network errors this means all retries fire immediately, potentially making rate-limiting worse. |
| 25 | `UNDOCUMENTED` | `FileLogger.close()` is a no-op. Callers that rely on `close()` to flush pending writes will not get the expected behavior (synchronous writes mean there is nothing to flush, but the API suggests there might be). |
| 26 | `UNDOCUMENTED` | `shouldSkipTask` in `run-state.ts` only skips `"success"` status. A task that previously errored will be re-attempted, but a task that previously failed will also be re-attempted — there is no "permanent failure" skip status. |
| 27 | `UNDOCUMENTED` | `environment.ts` maps all non-Windows, non-macOS platforms to `"Linux"`. Running on BSD or other Unix will silently report as Linux. |

---

## MCP Server

**Files:** `src/mcp/server.ts`, `src/mcp/dispatch-worker.ts`, `src/mcp/tools/config.ts`, `src/mcp/tools/dispatch.ts`, `src/mcp/tools/fix-tests.ts`, `src/mcp/tools/spec.ts`, `src/mcp/tools/monitor.ts`, `src/mcp/tools/recovery.ts`, `src/mcp/state/database.ts`, `src/mcp/state/manager.ts`

### Behaviors

- **17 tools** registered across 6 groups: config (2), dispatch (2), fix-tests (1), spec (5), monitor (4), recovery (2).
- Fire-and-forget tools (`dispatch_run`, `fix_tests`, `spec_generate`, `run_retry`, `task_retry`) all fork child processes and return immediately with a run ID.
- `dispatch_dry_run` is the only tool that runs in-process synchronously.
- SQLite database at `.dispatch/dispatch.db` with WAL mode; 3 tables: `runs`, `tasks`, `spec_runs`.
- Live run registry: in-memory `Map` with completion callbacks + 2-second poll fallback for long-polling callers.
- Forked workers send a 30-second heartbeat.
- `forkDispatchRun` forks `dist/mcp/dispatch-worker.js` — **requires a compiled build to be present**.
- Two explicit security controls: `spec_read` has a path traversal guard; `config_set` blocks the `agents` key.

### Gaps

| # | Classification | Finding |
|---|---|---|
| 28 | `WRONG_IMPL` | HTTP transport has **no authentication**. Any process that can reach the port can invoke any MCP tool. Default bind to loopback (`127.0.0.1`) mitigates but does not eliminate the risk (other local processes, SSRF, etc.). |
| 29 | `WRONG_IMPL` | `forkDispatchRun` forks `dist/mcp/dispatch-worker.js`. If the user has not run a build, the MCP server will silently fail to dispatch work (the fork will error because the file does not exist). |
| 30 | `WRONG_IMPL` | `spec_list` silently swallows ENOENT; `listSpecRuns()` failures are completely swallowed. Callers receive empty results with no indication that an error occurred. |
| 31 | `UNDOCUMENTED` | `issues_fetch` embeds per-item errors inline in the response rather than failing the whole call. Callers must inspect each item to detect partial failures. |
| 32 | `UNDOCUMENTED` | The live run registry uses a 2-second poll as a fallback for long-polling — there is no documented maximum wait time for a caller. |
| 33 | `UNDOCUMENTED` | `config_set` silently blocks the `agents` key with no error message explaining why. Users attempting to set agent config via MCP will receive a generic failure. |

---

## Summary Table

| # | Subsystem | Classification | Short description |
|---|---|---|---|
| 1 | CLI/Config | `WRONG_IMPL` | Wizard silently drops fields it doesn't prompt for |
| 2 | CLI/Config | `WRONG_IMPL` | Provider check fires before default is merged |
| 3 | CLI/Config | `UNDOCUMENTED` | `explicitFlags` drives three-tier merge |
| 4 | Orchestrator | `WRONG_IMPL` | `testTimeout` computed but never used |
| 5 | Orchestrator | `WRONG_IMPL` | Fix-tests makes only one attempt despite `resolvedRetries` |
| 6 | Orchestrator | `WRONG_IMPL` | `buildPrTitle` uses oldest commit, not newest |
| 7 | Orchestrator | `UNDOCUMENTED` | Retry upsert overwrites earlier result |
| 8 | Orchestrator | `UNDOCUMENTED` | Temp dirs never explicitly deleted |
| 9 | Agents | `WRONG_IMPL` | Commit agent accepts response with only one of two required fields |
| 10 | Agents | `WRONG_IMPL` | `Codex.send()` is a no-op |
| 11 | Agents | `UNDOCUMENTED` | OpenCode cwd passed via prompt only, not process spawn |
| 12 | Agents | `UNDOCUMENTED` | `Claude.close()` uses `Promise.resolve()` wrapper for compat |
| 13 | Datasources | `WRONG_IMPL` | `buildBranchName` ignores `title` param in all three datasources |
| 14 | Datasources | `WRONG_IMPL` | `deriveShortUsername` copy-pasted across all three files |
| 15 | Datasources | `WRONG_IMPL` | GitHub `getOwnerRepo()` runs subprocess on every call |
| 16 | Datasources | `WRONG_IMPL` | MD datasource inconsistent error handling for missing resources |
| 17 | Datasources | `WRONG_IMPL` | MD `nextIssueId` has no concurrency protection |
| 18 | Datasources | `UNDOCUMENTED` | MD `update()` ignores `title` argument |
| 19 | Datasources | `UNDOCUMENTED` | ADO `doneStateCache` never evicted |
| 20 | Parser | `WRONG_IMPL` | `detectTestCommand` always returns `"npm test"` |
| 21 | Parser | `WRONG_IMPL` | `CHECKED_RE` defined but never used |
| 22 | Parser | `UNDOCUMENTED` | Unrecognized H2 sections after postamble silently discarded |
| 23 | Parser | `UNDOCUMENTED` | `defaultConcurrency()` is memory-gated |
| 24 | Helpers | `WRONG_IMPL` | `withRetry` has no backoff delay |
| 25 | Helpers | `UNDOCUMENTED` | `FileLogger.close()` is a no-op |
| 26 | Helpers | `UNDOCUMENTED` | `shouldSkipTask` has no permanent-failure skip status |
| 27 | Helpers | `UNDOCUMENTED` | Non-Unix platforms silently mapped to "Linux" |
| 28 | MCP | `WRONG_IMPL` | HTTP transport has no authentication |
| 29 | MCP | `WRONG_IMPL` | `forkDispatchRun` requires compiled build to exist |
| 30 | MCP | `WRONG_IMPL` | `spec_list` / `listSpecRuns` silently swallow errors |
| 31 | MCP | `UNDOCUMENTED` | `issues_fetch` embeds per-item errors inline |
| 32 | MCP | `UNDOCUMENTED` | No documented max wait time for long-polling |
| 33 | MCP | `UNDOCUMENTED` | `config_set` blocks `agents` key with no explanation |

**Totals:** 14 `WRONG_IMPL` · 0 `MISSING_IMPL` · 0 `DOCS_STALE` · 19 `UNDOCUMENTED`  
(No `MISSING_IMPL` or `DOCS_STALE` found — audit was spec-unaware so doc comparison was not performed.)
