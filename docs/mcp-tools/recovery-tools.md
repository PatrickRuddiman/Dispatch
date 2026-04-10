# Recovery Tools

The recovery tools allow MCP clients to retry failed dispatch runs and
individual failed tasks. Both tools are async — they create a new run record,
fork a worker process, and return immediately with a new `runId`.

**Source file:** `src/mcp/tools/recovery.ts`

## Tools

### run_retry

Re-runs all failed tasks from a previous dispatch run. Creates a new run with
only the failed issue IDs rather than the entire original set.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | Yes | — | The original `runId` to retry failed tasks from |
| `provider` | `enum` | No | From config | Agent provider override |
| `concurrency` | `integer` | No | From config or 1 | Max parallel tasks (1-32) |

**Response:**

```json
{
  "runId": "new-uuid-...",
  "status": "running",
  "originalRunId": "original-uuid-..."
}
```

**Execution flow:**

1. Looks up the original run via `getRun(args.runId)`. Returns an error if
   not found.
2. Retrieves all tasks for the run via `getTasksForRun(args.runId)`.
3. Filters for tasks with `status === "failed"`.
4. **Smart retry logic**:
    - If failed tasks exist, extracts the unique issue IDs from their `file`
      fields using `parseIssueFilename()`. Only the issues that actually
      failed are re-dispatched.
    - If no failed tasks exist but the run itself has `status === "failed"`,
      the run failed before creating any tasks (e.g., a config or boot error).
      In this case, all original issue IDs are re-dispatched.
    - If no failed tasks exist and the run is not in a failed state, returns a
      "No failed tasks found" message (nothing to retry).
5. Loads config via `loadMcpConfig()` and creates a new run record.
6. Forks a worker via `forkDispatchRun()` with `force: true` to bypass safety
   checks (the user already confirmed the original run).

**Issue ID extraction:** The `parseIssueFilename()` helper from
`src/orchestrator/datasource-helpers.ts` extracts the issue ID from the task's
`file` field (e.g., `"42-add-auth.md"` → `"42"`). If parsing fails, the
recovery tool falls back to using all original issue IDs.

### task_retry

Retries a specific failed task by its `taskId` from a previous run. Creates a
new run targeting only the single issue associated with the task.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | Yes | — | The original `runId` |
| `taskId` | `string` | Yes | — | The `taskId` to retry (obtained from `status_get`) |
| `provider` | `enum` | No | From config | Agent provider override |

**Response:**

```json
{
  "runId": "new-uuid-...",
  "status": "running",
  "taskId": "42:1"
}
```

**Execution flow:**

1. Looks up the original run and verifies the specified task exists in that
   run.
2. Extracts the issue ID from the task's `file` field using
   `parseIssueFilename()`. Falls back to all original issue IDs if parsing
   fails.
3. Creates a new run with `issueIds` containing just the single extracted
   issue ID.
4. Forks a worker with `concurrency: 1` and `force: true`.

**Concurrency is always 1:** When retrying a single task, concurrency is
hardcoded to 1 because only one issue is being dispatched. This is a
deliberate design choice — even if the original run used higher concurrency,
a single-task retry should not create unnecessary parallelism.

## Recovery behavior

### Retry scope

Both recovery tools create entirely new dispatch runs — they do not resume the
original run. This means:

- A new `runId` is generated and tracked independently.
- The original run's state remains unchanged (its `status` stays `"failed"`).
- The new run goes through the full pipeline: config loading, orchestrator
  boot, task planning (unless `noPlan` was set), executor execution, and git
  lifecycle.

### Force flag

Both tools set `force: true` in the worker message. This bypasses safety
checks like the large-batch confirmation prompt, which would be inappropriate
for retry scenarios where the user has already confirmed intent by explicitly
calling the retry tool.

### Failed task identification

The `parseIssueFilename()` function parses Dispatch's file naming convention
(`{issueId}-{slug}.md`) to extract issue IDs from task records. The task's
`file` field stores the spec file path, and the `taskId` stores a composite
key like `"42:1"` (issue 42, task 1). Either field can be used to identify the
originating issue.

If `parseIssueFilename()` fails (e.g., the file field contains an unexpected
format), the recovery tools fall back to re-dispatching all original issue IDs.
This is a safe default — the pipeline will re-check which tasks still need
work.

## Relationship with dispatch_run

Recovery tools produce the same type of run as `dispatch_run`. The worker
message has `type: "dispatch"` and includes the same configuration fields.
The only differences are:

| Aspect | `dispatch_run` | `run_retry` / `task_retry` |
|--------|---------------|---------------------------|
| Issue selection | Caller-specified | Derived from failed tasks |
| `force` flag | Caller-specified | Always `true` |
| Concurrency | Caller or config | Config or `1` for `task_retry` |
| Run record | New run | New run (not linked to original in DB) |

## Related documentation

- [MCP Tools Overview](./overview.md) — Tool catalog and registration architecture
- [Fork-Run IPC Bridge](./fork-run-ipc.md) — IPC message protocol used by forked workers
- [Monitor Tools](./monitor-tools.md) — `status_get` to check which tasks failed
- [Dispatch Tools](./dispatch-tools.md) — `dispatch_run` for fresh dispatches
- [Datasource Helpers](../datasource-system/datasource-helpers.md) — `parseIssueFilename()` utility
- [MCP Tools Tests](../testing/mcp-tools-tests.md) — Unit tests for
  `run_retry` and `task_retry` tool handlers, including the Bug 6 fix for
  pre-task failures
- [Troubleshooting](../dispatch-pipeline/troubleshooting.md) — Diagnosing
  pipeline failures that lead to retry scenarios
