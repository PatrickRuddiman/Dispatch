# Spec Tools

The spec tools manage specification generation and retrieval. They cover the
full spec lifecycle: generating specs from issues via AI-driven codebase
exploration, listing and reading existing spec files, and monitoring spec
generation runs.

**Source file:** `src/mcp/tools/spec.ts`

## Tools

### spec_generate

Generates spec files from issue IDs, glob patterns, or inline text. This is
an async tool — it returns a `runId` immediately and pushes progress via MCP
logging notifications.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `issues` | `string` | Yes | — | Comma-separated issue IDs (e.g., `"42,43"`), a glob pattern (e.g., `"drafts/*.md"`), or an inline description |
| `provider` | `enum` | No | From config | Agent provider name |
| `source` | `enum` | No | From config | Issue datasource: `"github"`, `"azdevops"`, `"md"` |
| `concurrency` | `integer` | No | From config | Max parallel spec generations (1-32) |
| `dryRun` | `boolean` | No | `false` | Preview without generating |
| `respec` | `boolean` | No | `false` | Regenerate existing specs (overwrites). When `issues` is `"*"` or empty with `respec: true`, regenerates all discovered specs. |

**Response:**

```json
{ "runId": "550e8400-...", "status": "running" }
```

**Execution flow:**

1. Loads configuration via `loadMcpConfig()`.
2. **Respec resolution**: If `respec: true` and `issues` is `"*"` or empty,
   queries the datasource to discover all existing issues and builds the
   issue list from their numbers. Returns an error if no existing specs are
   found.
3. Creates a spec run record via `createSpecRun({ cwd, issues })`.
4. Forks a worker via `forkDispatchRun()` with a `type: "spec"` message and
   a custom `onDone` callback.
5. Returns immediately with the `runId`.

**Custom `onDone` callback:** Unlike dispatch runs, spec runs use the
`ForkRunOptions.onDone` callback to handle completion. When the worker sends
a `done` message with a result containing a `generated` field, the callback
calls `finishSpecRun()` with spec-specific counters (`total`, `generated`,
`failed`). This is necessary because spec runs use a different SQLite table
(`spec_runs`) with different columns than dispatch runs.

**Worker message structure:**

```json
{
  "type": "spec",
  "cwd": "/path/to/project",
  "opts": {
    "issues": "42,43",
    "provider": "copilot",
    "model": "claude-sonnet-4",
    "issueSource": "github",
    "concurrency": 2,
    "specTimeout": 10,
    "specWarnTimeout": 5,
    "specKillTimeout": 15,
    "dryRun": false,
    "cwd": "/path/to/project"
  }
}
```

### spec_list

Lists spec files in the `.dispatch/specs/` directory and recent spec
generation runs.

**Parameters:** None.

**Response:**

```json
{
  "files": ["42-add-auth.md", "43-fix-login.md"],
  "specsDir": "/path/to/project/.dispatch/specs",
  "recentRuns": [
    { "runId": "...", "status": "completed", "total": 2, "generated": 2, "failed": 0 }
  ]
}
```

**Behavior notes:**

- Returns an empty `files` array if the `.dispatch/specs/` directory does
  not exist (ENOENT is silently handled).
- Non-ENOENT filesystem errors are returned in an `error` field alongside
  the empty files array.
- Only `.md` files are listed. Files are sorted alphabetically.
- `recentRuns` includes the 5 most recent spec runs from the database.
  If the database is not initialized, `recentRuns` defaults to an empty
  array (the error is silently caught).

### spec_read

Reads the contents of a single spec file. Includes a path-traversal guard
to prevent reading files outside the specs directory.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file` | `string` | Yes | — | Filename or relative path of the spec file (e.g., `"42-add-auth.md"`) |

**Response:** The raw text content of the spec file.

**Path resolution:**

- If the `file` argument contains no path separators (`/` or `\`), it is
  treated as a bare filename and joined with the specs directory.
- If it contains path separators, it is resolved relative to the specs
  directory using `resolve()`.
- Absolute paths from user input are never used directly — they are always
  resolved relative to `specsDir`.

**Path-traversal guard:**

After resolving the candidate path, the tool checks that it starts with the
specs directory path (plus path separator). This prevents directory traversal
attacks like `file: "../../etc/passwd"`:

```
candidatePath.startsWith(specsDir + sep)
```

If the check fails, the tool returns `"Access denied: path must be inside
the specs directory"` with `isError: true`.

### spec_runs_list

Lists recent spec generation runs with their status.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | `integer` | No | 20 | Max results (1-100) |

**Response:** A JSON array of spec run records, sorted by `startedAt`
descending (newest first).

### spec_run_status

Gets the status of a specific spec generation run. Supports the same
long-poll mechanism as `status_get`.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | Yes | — | The `runId` returned by `spec_generate` |
| `waitMs` | `integer` | No | 0 | Hold response until run completes or timeout (ms). Max 120,000. |

**Response:**

```json
{
  "runId": "...",
  "cwd": "/path/to/project",
  "issues": "\"42,43\"",
  "status": "completed",
  "startedAt": 1712678400000,
  "finishedAt": 1712678520000,
  "total": 2,
  "generated": 2,
  "failed": 0,
  "error": null
}
```

When the run is still in progress, the response includes `retryAfterMs: 5000`.

The long-poll behavior is identical to `status_get` — it uses
`waitForRunCompletion()` with the same hybrid event-driven + polling approach.
The only difference is that it queries `getSpecRun()` instead of `getRun()`.

## Spec runs vs dispatch runs

Spec runs are tracked in a separate SQLite table (`spec_runs`) from dispatch
runs (`runs`). The key differences:

| Aspect | Dispatch Runs | Spec Runs |
|--------|--------------|-----------|
| Table | `runs` | `spec_runs` |
| Create function | `createRun()` | `createSpecRun()` |
| Finish function | `finishRun()` | `finishSpecRun()` |
| Counters | total, completed, failed | total, generated, failed |
| Per-task tracking | Yes (tasks table) | No |
| Status values | running, completed, failed, cancelled | running, completed, failed |
| Input field | `issueIds` (JSON array) | `issues` (raw string) |

Spec runs store the raw `issues` input string (comma-separated IDs, glob, or
inline text) rather than a parsed array, because the spec pipeline handles
input classification internally.

## IPC message handling

The `spec_generate` tool uses two IPC message flows:

1. **`spec_progress` messages**: Handled by the generic `_fork-run.ts` handler
   which translates `item_start`, `item_done`, `item_failed`, and `log`
   sub-types into MCP logging notifications. No database mutations occur for
   spec progress events.

2. **`done` message**: Handled by the custom `onDone` callback which calls
   `finishSpecRun()` with the spec-specific counters from the result.

## Security: path traversal protection

The `spec_read` tool's path-traversal guard is a defense-in-depth measure.
Since MCP tools accept arbitrary string inputs from AI clients, a malicious
or confused client could attempt to read files outside the specs directory.
The guard ensures that only files within `.dispatch/specs/` are accessible,
regardless of the path manipulation attempted.

The check uses `candidatePath.startsWith(specsDir + sep)` which correctly
handles edge cases like `specsDir` being a prefix of another directory name
(e.g., `/path/specs` vs `/path/specs-backup`).

## Related documentation

- [MCP Tools Overview](./overview.md) — Tool catalog and registration architecture
- [Fork-Run IPC Bridge](./fork-run-ipc.md) — IPC message protocol and
  `spec_progress` handling
- [Config Resolution](./config-resolution.md) — Configuration loading for
  the spec pipeline
- [Spec Generation](../spec-generation/overview.md) — The spec pipeline that
  the worker executes
- [State Management](../mcp-server/state-management.md) — SQLite `spec_runs`
  table and CRUD operations for spec run tracking
- [Monitor Tools](./monitor-tools.md) — `status_get` for dispatch run
  monitoring (analogous to `spec_run_status`)
- [Spec Generator Tests](../testing/spec-generator-tests.md) — Tests covering
  spec generation, extraction, and validation
