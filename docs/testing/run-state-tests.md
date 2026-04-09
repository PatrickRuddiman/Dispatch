# Run-State Tests

Test file: [`src/tests/run-state.test.ts`](../../src/tests/run-state.test.ts)
(239 lines)

Production module: [`src/helpers/run-state.ts`](../../src/helpers/run-state.ts)
(173 lines)

## What this file tests

The run-state test file validates the persistence layer that enables
interrupted [dispatch runs](../dispatch-pipeline/pipeline-lifecycle.md) to resume without re-executing successful tasks.
It tests four functions: `loadRunState`, `saveRunState`, `buildTaskId`, and
`shouldSkipTask`. It answers the question: **does the run-state module
correctly persist task completion status to SQLite, migrate legacy JSON data,
and make accurate skip/retry decisions based on stored state?**

## Why it matters

When a dispatch run is interrupted (process crash, network failure, timeout),
the run-state allows the system to resume from where it left off. Without
correct persistence, the system would either re-execute already-completed
tasks (wasting time and potentially creating duplicate PRs/branches) or
incorrectly skip failed tasks that need retry. The migration path from
JSON to SQLite is equally critical -- an incorrect migration would lose
the completion state of an in-progress run.

## Test structure

The file contains 4 `describe` blocks with 12 tests total:

### loadRunState (3 tests)

Tests loading run state from the SQLite database:

- **Returns null when no state exists**: When the `run_state` table has no
  rows, `loadRunState` returns `null`. This is the initial state for a fresh
  project directory.

- **Returns parsed RunState when row exists**: The test configures the mock
  database to return a run row and task rows, then verifies the returned
  `RunState` object has the correct `runId`, `preRunSha`, and task array.
  Task rows are mapped from `{ task_id, status, branch }` to
  `{ id, status, branch }`.

- **Falls back to "pending" for unrecognized status**: When a task row's
  `status` column contains an unrecognized value (e.g., `"UNKNOWN"`), the
  Zod `safeParse` at [`run-state.ts:125-128`](../../src/helpers/run-state.ts)
  returns `success: false`, and the code falls back to `"pending"`. This
  defensive behavior prevents data corruption from crashing the resume
  flow -- the task will simply be re-executed.

### saveRunState (1 test)

Tests writing run state to the SQLite database:

- **Creates directory, bootstraps tables, and upserts rows**: Verifies that
  `saveRunState` calls `mkdir` with `{ recursive: true }` to create the
  `.dispatch` directory, calls `db.exec` to create tables, and uses
  `db.transaction` to atomically upsert the run row and task rows.

  The upsert uses SQLite's `ON CONFLICT ... DO UPDATE` clause:

  ```sql
  INSERT INTO run_state (run_id, pre_run_sha, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    pre_run_sha = excluded.pre_run_sha,
    updated_at = excluded.updated_at
  ```

  This means `saveRunState` is idempotent -- calling it multiple times with
  the same run ID updates the existing row rather than failing with a
  constraint violation.

### buildTaskId (2 tests)

Tests the pure function that converts a `Task` object to a string identifier:

- **Standard case**: `{ file: "/some/path/to/123-feature.md", line: 42 }`
  produces `"123-feature.md:42"`. The function uses `basename(task.file)`
  to strip the directory path.

- **No directory in path**: `{ file: "simple.md", line: 1 }` produces
  `"simple.md:1"`. `basename` is a no-op when there's no directory separator.

The `basename:line` format is used as the primary key for task lookup in
both the `run_state_tasks` table and the `tasks` table. It is deliberately
file-relative (not absolute path) so that the identifier remains stable
across different checkout locations.

### shouldSkipTask (6 tests)

Tests the skip-decision logic that determines whether a task should be
skipped during a resumed run:

| Task status in state | Should skip? | Rationale |
|---------------------|-------------|-----------|
| `"success"` | **yes** | Already completed; re-executing would waste time |
| `"failed"` | no | Needs retry |
| `"pending"` | no | Never started; needs execution |
| `"running"` | no | Was in progress when interrupted; needs re-execution |
| not found in state | no | New task not in previous run; needs execution |
| state is `null` | no | No prior state; first run |

The implementation is a one-liner at
[`run-state.ts:169-173`](../../src/helpers/run-state.ts):

```typescript
export function shouldSkipTask(taskId: string, state: RunState | null): boolean {
  if (!state) return false;
  const entry = state.tasks.find((t) => t.id === taskId);
  return entry?.status === "success";
}
```

Only `"success"` triggers a skip. Every other status (including `"running"`,
which indicates the task was mid-execution when the previous run was
interrupted) causes the task to be re-executed.

## Dual persistence domains

The run-state module maintains its own tables (`run_state`,
`run_state_tasks`) separate from the MCP server's tables (`runs`, `tasks`,
`spec_runs`). This separation exists because:

1. **Different lifecycles**: MCP server state tracks runs initiated via MCP
   tools. Run-state tracks the resume checkpoint for the orchestrator, which
   can be invoked from the CLI without the MCP server.

2. **Different schemas**: The MCP `tasks` table includes `task_text`, `file`,
   `line`, `branch`, `error`, `started_at`, `finished_at`. The run-state
   `run_state_tasks` table includes only `task_id`, `status`, and `branch` --
   the minimum needed for skip/retry decisions.

3. **Migration path**: Run-state originally used a JSON file
   (`.dispatch/run-state.json`). The SQLite implementation preserves the
   same public API while migrating data on first access.

Both domains share the same database file (`{cwd}/.dispatch/dispatch.db`)
opened by [`openDatabase(cwd)`](../mcp-server/state-management.md).

## JSON-to-SQLite migration

The migration logic at [`run-state.ts:80-99`](../../src/helpers/run-state.ts)
runs once per `cwd`:

1. Check `_migratedCwds` set to avoid re-migrating
2. Read `.dispatch/run-state.json`
3. Parse with `RunStateSchema.safeParse()` (Zod validation)
4. If valid and no existing DB record, call `saveRunState` to import
5. Leave the JSON file in place (for safety -- it is ignored after migration)

The test file does not explicitly test the migration flow because the
database module is fully mocked. Migration testing would require either an
integration test with a real filesystem and database, or a more granular
mock that simulates the `readFile` call returning valid JSON. The current
mock for `node:fs/promises` includes `readFile` but the default mock
configuration doesn't exercise the migration path.

## Mocking strategy

The test file mocks two modules:

| Mock target | Purpose |
|-------------|---------|
| `node:fs/promises` | `readFile`, `writeFile`, `rename`, `mkdir` -- prevents filesystem access |
| `../mcp/state/database.js` | `openDatabase` returns a fake DB with `exec`, `prepare`, `transaction` |

The fake database object (`mockDb`) is configured per-test in `beforeEach`:

- `mockDb.exec` -- no-op (used by `ensureRunStateTable`)
- `mockDb.prepare` -- returns statement-like objects with `get`, `all`, `run`
- `mockDb.transaction` -- executes the callback immediately

Tests override `mockDb.prepare` to return specific statement objects based
on call order. For example, in the "returns parsed RunState" test, the first
`prepare` call returns a statement whose `get()` returns the run row, and
the second call returns a statement whose `all()` returns task rows.

## Related documentation

- [Tests: MCP Server & State](mcp-state-tests.md) -- overview of all four
  test files in this group
- [Database Tests](database-tests.md) -- the SQLite layer that run-state
  stores data in
- [Manager Tests](manager-tests.md) -- the MCP server's separate CRUD layer
- [MCP Tools Tests](mcp-tools-tests.md) -- tool handlers that trigger
  dispatch runs which use run-state for resume
- [State Management](../mcp-server/state-management.md) -- production
  documentation for the MCP persistence layer
- [Dispatch Pipeline Tests](dispatch-pipeline-tests.md) -- integration tests
  for the dispatch pipeline that exercises run-state during execution
