# Dispatch Pipeline Tests

This document covers the two test files that verify the dispatch pipeline
(`src/orchestrator/dispatch-pipeline.ts`): the unit test suite and the
integration test suite.

## Test file inventory

| Test file | Production module | Lines (test) | Test count | Category |
|-----------|-------------------|-------------|------------|----------|
| `dispatch-pipeline.test.ts` | `src/orchestrator/dispatch-pipeline.ts` | ~1,930 | 70+ | Module mocks, pipeline lifecycle |
| `integration/dispatch-flow.test.ts` | `src/orchestrator/dispatch-pipeline.ts` | ~290 | 3 | Real md datasource, git repo |

**Total: ~2,220 lines of test code** covering the dispatch pipeline's
execution lifecycle, retry mechanics, worktree mode, feature branch workflow,
commit agent integration, and edge cases.

## Unit tests (`dispatch-pipeline.test.ts`)

### Mock architecture

The unit tests use Vitest's `vi.mock()` to replace all external dependencies
with controllable mocks. Mocks are defined in a `vi.hoisted()` block so they
are available before module imports:

| Mocked module | Key mock functions | Purpose |
|---------------|-------------------|---------|
| `providers/index.js` | `bootProvider` | Returns a mock `ProviderInstance` with `createSession`, `prompt`, `cleanup` |
| `agents/planner.js` | `boot` | Returns mock `PlannerAgent` with configurable `plan()` |
| `agents/executor.js` | `boot` | Returns mock executor with configurable `execute()` |
| `agents/commit.js` | `boot` | Returns mock commit agent with configurable `generate()` |
| `datasources/interface.js` | `getDatasource` | Returns mock datasource with `list`, `update`, `supportsGit`, `createPullRequest`, etc. |
| `helpers/worktree.js` | `createWorktree`, `removeWorktree`, `worktreeName` | Worktree lifecycle |
| `helpers/branch.js` | `createAndSwitchBranch`, `switchBranch`, `pushBranch`, etc. | Branch operations |
| `helpers/cleanup.js` | `registerCleanup` | Cleanup registration (no-op in tests) |
| `tui.js` | `createTui` | Returns mock TUI with `state`, `update`, `stop` |
| `helpers/logger.js` | `log` | Silent logger with `vi.fn()` for all methods |

### Test suites

The unit tests are organized into eight `describe` blocks:

#### Planning timeout and retry (10 tests)

Verifies the planning retry loop at `dispatch-pipeline.ts:386-415`:

- **Succeeds on first attempt** — planner returns success within timeout
- **Retries on timeout** — `TimeoutError` triggers retry, succeeds on second
  attempt
- **All attempts exhausted** — two timeouts produce a failed task
- **Non-timeout errors skip retry** — non-`TimeoutError` errors fail
  immediately
- **`--no-plan` skips planning** — executor receives `null` plan
- **`planRetries: 0`** — exactly one attempt, no retry
- **Default timeout and retries** — uses `DEFAULT_PLAN_TIMEOUT_MIN` (10 min)
  and `DEFAULT_PLAN_RETRIES` (1)
- **Fallback to general retries** — when `planRetries` is unset, uses the
  `retries` option
- **Immediate failure on non-timeout** — verifies no retry for generic errors

#### Verbose mode (4 tests)

Verifies the verbose mode bypass at `dispatch-pipeline.ts:93-120`:

- TUI is not created when `log.verbose` is `true`
- Phase transitions are logged inline
- Task progress is logged inline
- TUI is created normally when `log.verbose` is `false`

#### Dry-run mode (3 tests)

Verifies `dryRunMode()` at `dispatch-pipeline.ts:780-850`:

- Returns empty summary when no source configured
- Returns empty summary when no items found
- Returns correct `skipped` count when tasks are found

#### Edge cases (5 tests)

Verifies early-exit and error paths:

- Empty summary when no source configured
- Empty summary when no items from datasource
- Empty summary when no unchecked tasks
- Delegation to `dryRunMode` when `dryRun: true`
- Branch lifecycle exercised when `noBranch: false`
- Executor failure produces failed task result

#### Commit safety-net (3 tests)

Verifies `commitAllChanges()` integration at `dispatch-pipeline.ts:533`:

- Called after task execution when branching is enabled
- **Not** called when branching is disabled
- Pipeline continues gracefully if `commitAllChanges` throws

#### Branch creation failure (3 tests)

Verifies error handling when `createAndSwitchBranch` rejects:

- All tasks marked as failed
- Executor not invoked
- Succeeds when `noBranch: true` (branch creation is skipped)

#### `supportsGit()` guard (2 tests)

Verifies the datasource `supportsGit()` check:

- Git lifecycle calls skipped when `supportsGit()` returns `false`
- Git lifecycle calls made when `supportsGit()` returns `true`

#### Commit agent integration (6 tests)

Verifies the commit agent pipeline at `dispatch-pipeline.ts:533-566`:

- Uses commit agent output for PR title and body on success
- Falls back to `buildPrTitle`/`buildPrBody` when commit agent fails
- Squashes commits when commit agent provides a message
- Continues gracefully when commit agent throws
- Skips commit agent when branch diff is empty
- Skips commit agent when branching is disabled

#### Worktree dispatch pipeline (18 tests)

The largest test suite, covering worktree-parallel execution:

**Multi-issue worktree mode:**
- Creates a worktree for each issue file
- Passes worktree path as `cwd` to executor
- Calls `removeWorktree` for each issue
- Registers cleanup handlers for worktrees
- Tags TUI tasks with worktree name
- Does not call `switchBranch`/`createAndSwitchBranch` in worktree mode
- Passes worktree `cwd` to `commitAllChanges`
- Fails tasks when worktree creation fails
- Boots separate provider instance per worktree
- Boots per-worktree planner and executor agents
- Passes `issueCwd` and `worktreeRoot` to planner/executor/commitAgent

**Serial fallback:**
- Single-issue runs use serial mode
- `--no-worktree` forces serial branch mode
- Single shared provider when `useWorktrees` is false
- Planner and executor booted once with shared provider

**Executor retry (3 tests):**
- Retries executor on failure and succeeds on retry
- Fails the task when all executor attempts are exhausted
- Does not retry when executor succeeds on first attempt

#### Error-path handling (2 tests)

- Propagates error when `fetchItemsById` rejects
- Logs warning and continues when `datasource.update()` fails

#### Feature branch workflow (18 tests)

Comprehensive coverage of the feature branch flow:

- Creates feature branch from the default branch
- Switches back to default branch after creating feature branch
- Creates worktrees with feature branch as start point
- Merges working branches via `git merge --no-ff`
- Deletes working branches after merge via `git branch -d`
- Removes worktrees before merging
- Pushes the feature branch after all issues
- Creates a single aggregated PR
- Uses `buildFeaturePrTitle`/`buildFeaturePrBody` for the aggregated PR
- Does not push individual working branches
- Switches back to default branch after feature PR creation
- Returns correct summary with completed count
- Fails all tasks when feature branch creation fails
- Does not create worktrees when feature branch creation fails
- Registers cleanup handler for feature branch
- Continues gracefully when merge fails
- Continues gracefully when working branch deletion fails
- Processes issues serially in feature mode (not in parallel)

## Integration tests (`integration/dispatch-flow.test.ts`)

### What makes these integration tests

Unlike the unit tests, the integration tests use a **real markdown
datasource** and **real git repository** with real filesystem I/O. Only the
provider and agent modules are mocked. The tests:

1. Create a temporary directory with `mkdtemp()`
2. Initialize a real git repository (`git init`, `git commit`)
3. Write spec files to `.dispatch/specs/`
4. Call `runDispatchPipeline()` with `source: "md"` and `noBranch: true`
5. Verify the returned `DispatchSummary`

### Mock scope (minimal)

| Mocked | Real |
|--------|------|
| Provider (`bootProvider`) | Markdown datasource (`source: "md"`) |
| Planner (`planner.plan()`) | Task parser (`parseTaskFile`) |
| Executor (`executor.execute()`) | Git repository (real `git init`) |
| TUI (`createTui`) | Filesystem (real `mkdtemp`, `writeFile`) |
| Cleanup (`registerCleanup`) | `markTaskComplete()` — called by mock executor |
| Worktree helpers | — |

The mock executor calls `markTaskComplete(task)` to simulate the real
executor's behavior of checking off tasks after completion.

### Test cases

| Test | What it verifies |
|------|-----------------|
| Full dispatch with multi-task spec | End-to-end: discover → parse → plan → execute → summary. Verifies task count, completion count, planner call count, executor call count. |
| Single-task spec file | Minimal happy path with one task. |
| `noPlan` mode | Skips planning phase entirely — verifies planner is NOT called but executor still runs. |

### Cleanup

Each test creates a unique temp directory and removes it in `afterEach`:

```
afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

## Testing patterns

### Fixture design

Unit tests define task fixtures in the `vi.hoisted()` block:

- `TASK_FIXTURE` / `TASK_FILE_FIXTURE` — single task in
  `/tmp/dispatch-test/1-test.md`
- `TASK_FIXTURE_2` / `TASK_FILE_FIXTURE_2` — second task in
  `/tmp/dispatch-test/2-bugfix.md` (used for multi-issue tests)

These fixtures are reused across all test suites, with mock return values
configured per-test in `beforeEach` or within individual `it()` blocks.

### Two-issue test setup

Tests that verify worktree or multi-issue behavior configure the mock
datasource to return two task files:

```
mockParseTaskFile
  .mockResolvedValueOnce(TASK_FILE_FIXTURE)    // Issue 1
  .mockResolvedValueOnce(TASK_FILE_FIXTURE_2)  // Issue 2
```

### Verifying git command sequences

Feature branch tests verify the sequence of git operations by inspecting mock
call arguments. For example, to verify that `git merge --no-ff` was called
with the correct branch name:

```
const mergeCalls = mockExecFile.mock.calls.filter(
  (c) => c[1]?.[0] === "merge"
);
expect(mergeCalls[0][1]).toContain("--no-ff");
```

## Related documentation

- [Dispatch Pipeline](../cli-orchestration/dispatch-pipeline.md) — the
  production code these tests verify
- [Test Suite Overview](overview.md) — project-wide test framework and
  conventions
- [Runner Tests](runner-tests.md) — tests for the orchestrator runner
- [Planner & Executor Tests](planner-executor-tests.md) — tests for the
  agent layer
- [Planning & Dispatch Overview](../planning-and-dispatch/overview.md) — the
  pipeline stages that these tests exercise
- [Dispatcher](../planning-and-dispatch/dispatcher.md) — dispatch logic
  tested via mocks in these tests
- [Git & Worktree Management](../git-and-worktree/overview.md) — worktree
  lifecycle tested in the worktree dispatch suite
- [Markdown Datasource](../datasource-system/markdown-datasource.md) — real
  md datasource used in integration tests
- [Provider Tests](provider-tests.md) — complementary provider-level tests
- [Spec Generator Tests](spec-generator-tests.md) — spec pipeline tests
