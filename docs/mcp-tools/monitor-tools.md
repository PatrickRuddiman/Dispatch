# Monitor Tools

The monitor tools provide read-only access to run state, task details, and
issue data. They are all sync tools that execute in the MCP server process and
return results directly without forking child processes.

**Source file:** `src/mcp/tools/monitor.ts`

## Tools

### status_get

Returns the current status of a dispatch or spec run, including per-task
details. Supports optional long-polling to hold the response until the run
completes or a timeout elapses.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | Yes | — | The `runId` returned by `dispatch_run`, `spec_generate`, or recovery tools |
| `waitMs` | `integer` | No | 0 | Hold response until run completes or timeout (ms). Max 120,000. 0 = return immediately. |

**Response:**

```json
{
  "run": {
    "runId": "550e8400-...",
    "cwd": "/path/to/project",
    "issueIds": "[\"42\"]",
    "status": "completed",
    "startedAt": 1712678400000,
    "finishedAt": 1712678520000,
    "total": 3,
    "completed": 3,
    "failed": 0,
    "error": null
  },
  "tasks": [
    {
      "taskId": "42:1",
      "taskText": "Add authentication middleware",
      "file": "src/auth.ts",
      "line": 1,
      "status": "success",
      "branch": "dispatch/42-add-auth",
      "error": null,
      "startedAt": 1712678401000,
      "finishedAt": 1712678450000
    }
  ]
}
```

When the run is still in progress, the response includes a `retryAfterMs`
hint:

```json
{
  "run": { "status": "running", ... },
  "tasks": [...],
  "retryAfterMs": 5000
}
```

**Long-poll behavior:**

When `waitMs > 0` and the run is still `"running"`, the tool calls
`waitForRunCompletion()` from the state manager. This function uses a hybrid
approach:

1. **Immediate check**: If the run is already in a terminal state, returns
   immediately.
2. **Event-driven wakeup**: Registers a completion callback on the live-run
   registry for instant notification when `unregisterLiveRun()` is called.
3. **DB poll safety net**: Polls the database every 2 seconds to catch runs
   that completed between the initial check and callback registration.
4. **Timeout**: Returns after `waitMs` milliseconds (capped at 120 seconds)
   if the run has not completed.

After the wait resolves, `status_get` re-reads the run from the database to
get the final state.

### runs_list

Lists recent dispatch runs, optionally filtered by status.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | `enum` | No | All | Filter by status: `"running"`, `"completed"`, `"failed"`, `"cancelled"` |
| `limit` | `integer` | No | 20 | Max results (1-100) |

**Response:** A JSON array of run records, sorted by `startedAt` descending
(newest first).

### issues_list

Lists open issues from the configured datasource. This tool directly queries
the datasource (GitHub, Azure DevOps, or local markdown) rather than reading
from the SQLite database.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | `enum` | No | From config | Issue datasource: `"github"`, `"azdevops"`, `"md"` |
| `org` | `string` | No | From config | Azure DevOps organization URL |
| `project` | `string` | No | From config | Azure DevOps project name |
| `workItemType` | `string` | No | From config | Azure DevOps work item type filter |
| `iteration` | `string` | No | From config | Azure DevOps iteration path filter |
| `area` | `string` | No | From config | Azure DevOps area path filter |

**Response:** A JSON array of issue summaries:

```json
[
  {
    "number": "42",
    "title": "Add authentication",
    "state": "open",
    "labels": ["enhancement"],
    "url": "https://github.com/org/repo/issues/42"
  }
]
```

The response includes only summary fields (`number`, `title`, `state`,
`labels`, `url`) — not the full issue body. Use `issues_fetch` for full
details.

**Configuration fallback:** Loads `.dispatch/config.json` via `loadConfig()`
and merges tool arguments with config values. If no datasource is configured
or passed, returns an error.

### issues_fetch

Fetches full details for one or more issues from the datasource. Each issue is
fetched independently — a failure on one issue does not prevent others from
being returned.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `issueIds` | `string[]` | Yes | — | Issue IDs to fetch. Must contain at least one. |
| `source` | `enum` | No | From config | Issue datasource |
| `org` | `string` | No | From config | Azure DevOps organization URL |
| `project` | `string` | No | From config | Azure DevOps project name |

**Response:** A JSON array where each entry contains the issue ID and either
the full details or an error:

```json
[
  { "id": "42", "details": { "title": "Add auth", "body": "...", ... } },
  { "id": "999", "error": "Issue not found" }
]
```

**Concurrent fetching:** Issues are fetched in parallel using `Promise.all()`.
Each fetch is wrapped in its own try/catch so that individual failures are
returned alongside successful results.

## Data sources

The monitor tools read from two different data sources:

| Tool | Data Source | Access Pattern |
|------|-----------|----------------|
| `status_get` | SQLite database + in-memory live-run registry | `getRun()`, `getTasksForRun()`, `waitForRunCompletion()` |
| `runs_list` | SQLite database | `listRuns()`, `listRunsByStatus()` |
| `issues_list` | External datasource (GitHub/AzDevOps/filesystem) | `getDatasource().list()` |
| `issues_fetch` | External datasource | `getDatasource().fetch()` |

The run/task tools (`status_get`, `runs_list`) query the SQLite database at
`.dispatch/dispatch.db`. The issue tools (`issues_list`, `issues_fetch`)
delegate to the datasource abstraction layer, which in turn calls `gh` CLI,
`az` CLI, or reads local markdown files.

## Long-poll design

The `waitMs` parameter on `status_get` (and `spec_run_status` in the spec
tools) implements a server-side long-poll pattern. This avoids the overhead
of the client making repeated rapid requests to check run completion.

The `waitForRunCompletion()` function in the state manager implements a
belt-and-suspenders approach:

- **Event-driven**: If the run is in the live-run registry (i.e., its
  worker process is still alive), a completion callback is registered for
  instant wakeup when `finishRun()` calls `unregisterLiveRun()`.

- **Polling**: A 2-second interval polls the database as a safety net.
  This catches runs that completed between the initial status check and
  callback registration (race condition), as well as orphaned runs where
  the worker process crashed without sending a `done` message.

- **Timeout cap**: The wait is capped at 120 seconds regardless of the
  requested `waitMs`. Clients needing longer waits should poll with
  repeated `status_get` calls.

## Related documentation

- [MCP Tools Overview](./overview.md) — Tool catalog and registration architecture
- [Dispatch Tools](./dispatch-tools.md) — `dispatch_run` creates the runs that
  these tools monitor
- [Recovery Tools](./recovery-tools.md) — `run_retry` and `task_retry` use
  `getRun()` and `getTasksForRun()` from the same state manager
- [MCP Server State Management](../mcp-server/state-management.md) — SQLite
  schema, CRUD operations, and live-run registry
- [Datasource System](../datasource-system/overview.md) — The polymorphic
  layer that `issues_list` and `issues_fetch` delegate to
