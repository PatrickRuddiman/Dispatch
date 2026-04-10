# Database Tests

Test file: [`src/tests/database.test.ts`](../../src/tests/database.test.ts)
(163 lines)

Production module: [`src/mcp/state/database.ts`](../../src/mcp/state/database.ts)
(174 lines)

## What this file tests

The database test file validates the SQLite database lifecycle: opening,
schema creation, singleton behavior, closing, and resetting. It answers the
question: **does the database module correctly bootstrap a usable SQLite
store with the expected schema, and does the singleton pattern prevent
accidental multiple connections?**

## Why it matters

The database module is the foundation for all MCP server state. If
`openDatabase` fails to create the schema, no runs or tasks can be recorded.
If the singleton leaks (returns a different instance on each call), prepared
statements cached by the manager would reference a stale connection. If
`closeDatabase` doesn't actually close the connection, the WAL file and
shared-memory file persist and can cause issues on subsequent opens.

## Test structure

The file contains 6 `describe` blocks with 12 tests total:

### Status constants

Verifies that `RUN_STATUSES`, `TASK_STATUSES`, and `SPEC_STATUSES` contain
the expected string values. These constants define the finite state machines
for runs, tasks, and spec runs:

| Constant | Values | Used by |
|----------|--------|---------|
| `RUN_STATUSES` | `running`, `completed`, `failed`, `cancelled` | `runs.status`, `assertRunStatus()` |
| `TASK_STATUSES` | `pending`, `running`, `success`, `failed`, `skipped` | `tasks.status`, `assertTaskStatus()` |
| `SPEC_STATUSES` | `running`, `completed`, `failed` | `spec_runs.status`, `assertSpecStatus()` |

### openDatabase

Tests the core initialization function:

- **Creates `.dispatch` directory**: `openDatabase(cwd)` calls
  `mkdirSync(join(cwd, ".dispatch"), { recursive: true })` before creating
  the database file. The test verifies this by checking that the returned
  database object is defined and has an `exec` method.

- **Singleton pattern**: Calling `openDatabase` twice with the same `cwd`
  returns the same object reference (`db1 === db2`). This is critical
  because the manager module calls `getDb()` which relies on the singleton.

- **Schema creation**: After `openDatabase`, the following tables exist:
    - `schema_version` -- contains a single row with `version = 1`
    - `runs` -- dispatch run records
    - `tasks` -- per-run task records with foreign key to `runs`
    - `spec_runs` -- spec generation run records

    The test verifies `schema_version` by querying it directly and asserting
    `row.version === 1`. The other tables are verified by confirming that
    `SELECT * FROM <table> LIMIT 1` does not throw.

### Schema versioning

The schema version table exists to support forward-compatible migrations.
The production code at [`database.ts:124-128`](../../src/mcp/state/database.ts)
checks whether a version row exists and inserts one if missing:

```
const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
if (!row) {
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
}
```

`CURRENT_SCHEMA_VERSION` is `1`. The current implementation does not include
any `ALTER TABLE` migrations -- the version tracking infrastructure is in
place for future schema changes. When a migration is needed, the pattern
would be:

1. Check the stored version
2. If less than `CURRENT_SCHEMA_VERSION`, run `ALTER TABLE` statements
3. Update the version row

### WAL mode

WAL (Write-Ahead Logging) is enabled via `db.pragma("journal_mode = WAL")`
at [`database.ts:144`](../../src/mcp/state/database.ts). This pragma:

- Allows multiple concurrent readers without blocking the writer
- Reduces write contention on the database file
- Is especially important for the MCP server, where the parent process
  reads state while forked workers write progress updates via IPC

The tests do not explicitly assert WAL mode (there is no `PRAGMA journal_mode`
query in the test file), but they exercise the database under WAL conditions
by calling `openDatabase` on a real on-disk temp directory.

Additional pragmas set during `openDatabase`:

| Pragma | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `WAL` | Concurrent reader/writer access |
| `synchronous` | `NORMAL` | Balance between speed and durability (fsync on WAL checkpoints, not every transaction) |
| `foreign_keys` | `ON` | Enforce referential integrity between `tasks.run_id` and `runs.run_id` |

### getDb

- **Throws when database not opened**: `getDb()` throws `"Database not open"`
  when called before `openDatabase`. This is a guard against using the
  manager layer before the database is initialized.

- **Returns singleton after open**: After `openDatabase(cwd)`, `getDb()`
  returns the same instance.

### closeDatabase

- **Closes and resets**: After `closeDatabase()`, `getDb()` throws. This
  confirms that the singleton is nulled and the connection is closed.

- **Safe when no database open**: Calling `closeDatabase()` when `_db` is
  `null` does not throw. This enables safe cleanup in `afterEach` hooks.

### resetDatabase

- **Clears singleton without closing**: `resetDatabase()` sets `_db = null`
  without calling `db.close()`. This is used by tests to decouple the
  singleton state from the connection state. The distinction matters: a test
  that calls `resetDatabase()` leaves the underlying connection open (and
  potentially leaked), while `closeDatabase()` properly closes it.

### Schema persistence

Verifies a full round-trip: insert a row into the `runs` table and read it
back. This confirms that the schema DDL statements in `createSchema()`
produce valid tables with the expected columns and types.

## Setup and teardown

Each test creates a unique temp directory under `os.tmpdir()`:

```
const dir = join(tmpdir(), `dispatch-db-test-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
```

`beforeEach` calls `resetDatabase()` and creates a fresh temp directory.
`afterEach` calls `closeDatabase()`, `resetDatabase()`, and removes the
temp directory with `rmSync(dir, { recursive: true, force: true })`.

## Related documentation

- [Tests: MCP Server & State](mcp-state-tests.md) -- overview of all four
  test files in this group
- [Manager Tests](manager-tests.md) -- CRUD operations built on top of
  this database layer
- [State Management](../mcp-server/state-management.md) -- production
  documentation for the persistence layer
- [MCP Server Overview](../mcp-server/overview.md) -- how the database
  fits into the MCP server architecture
