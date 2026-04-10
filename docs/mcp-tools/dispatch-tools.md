# Dispatch Tools

The dispatch tools are the primary entry point for executing Dispatch's core
pipeline through MCP. They allow AI assistants to trigger full task execution
with git lifecycle management or preview what would be dispatched without
making changes.

**Source file:** `src/mcp/tools/dispatch.ts`

## Tools

### dispatch_run

Executes the dispatch pipeline for one or more issue IDs. This is an async
tool — it returns a `runId` immediately and pushes progress via MCP logging
notifications.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `issueIds` | `string[]` | Yes | — | Issue IDs to dispatch (e.g., `["42", "43"]`). Must contain at least one. |
| `provider` | `enum` | No | From config | Agent provider name (e.g., `"copilot"`, `"opencode"`, `"claude"`, `"codex"`) |
| `source` | `enum` | No | From config | Issue datasource: `"github"`, `"azdevops"`, `"md"` |
| `concurrency` | `integer` | No | From config or 1 | Max parallel tasks (1-32) |
| `noPlan` | `boolean` | No | `false` | Skip the planner agent phase |
| `noBranch` | `boolean` | No | `false` | Skip branch creation and PR lifecycle |
| `noWorktree` | `boolean` | No | `false` | Skip git worktree isolation |
| `retries` | `integer` | No | 0 | Retry attempts per task (0-10) |
| `feature` | `string` | No | — | Group issues into a single feature branch with this name |
| `planRetries` | `integer` | No | 0 | Number of planner retry attempts (0-10) |
| `force` | `boolean` | No | `false` | Bypass safety checks (e.g., large batch confirmation) |

**Response:**

```json
{ "runId": "550e8400-e29b-41d4-a716-446655440000", "status": "running" }
```

**Execution flow:**

1. Loads configuration via [`loadMcpConfig()`](./config-resolution.md) with
   provider and source overrides from tool arguments.
2. Creates a run record in SQLite via `createRun({ cwd, issueIds })`,
   returning a UUID `runId`.
3. Calls [`forkDispatchRun()`](./fork-run-ipc.md) with a `type: "dispatch"`
   worker message containing all pipeline options.
4. Returns immediately with the `runId`.

The worker message passed to the forked process includes all configuration
fields from the merged config (provider, model, fastProvider, fastModel,
agents, source, org, project, workItemType, iteration, area, username,
planTimeout) plus tool-specific overrides (concurrency, noPlan, noBranch,
noWorktree, retries, feature, planRetries, force).

**Monitoring a dispatch run:**

After receiving the `runId`, the client can:

- Wait for MCP logging notifications pushed via the SSE stream (automatic).
- Poll with [`status_get`](./monitor-tools.md) using the `runId`.
- Use `status_get` with `waitMs` for long-poll behavior (up to 120 seconds).
- List all runs with [`runs_list`](./monitor-tools.md).

### dispatch_dry_run

Previews the tasks that would be dispatched for the given issue IDs without
executing anything. This is a sync tool — it runs in-process and returns the
result directly.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `issueIds` | `string[]` | Yes | — | Issue IDs to preview. Must contain at least one. |
| `source` | `enum` | No | From config | Issue datasource: `"github"`, `"azdevops"`, `"md"` |

**Response:** A JSON object containing the dry-run result from the
orchestrator, which includes the tasks that would be created, their execution
order, and any issues found.

**Execution flow:**

1. Loads configuration via `loadMcpConfig()` with source override.
2. Boots the orchestrator via `bootOrchestrator({ cwd })`.
3. Calls `orchestrator.orchestrate()` with `dryRun: true` and the full config.
4. Returns the orchestrator result directly.

Unlike `dispatch_run`, this tool does not fork a child process, create a run
record, or set up IPC messaging. It runs the orchestrator's dry-run path
synchronously in the MCP server process, which is safe because dry runs only
read from the filesystem and datasource without making changes.

## Configuration merging

Both tools merge configuration from multiple sources with this priority:

1. **Tool arguments** (highest priority): `provider`, `source`, `concurrency`,
   etc., passed by the MCP client.
2. **Config file**: Values from `.dispatch/config.json` loaded by
   `loadMcpConfig()`.
3. **Defaults** (lowest priority): `concurrency` defaults to 1 if not set in
   either source.

The `provider` field is required — if not provided in arguments or config, the
tool returns an error. The `source` field auto-detects from the git remote if
not configured. See [Config Resolution](./config-resolution.md) for the full
resolution chain.

## Worker message structure

The `dispatch_run` tool sends this message to the forked worker:

```json
{
  "type": "dispatch",
  "cwd": "/path/to/project",
  "opts": {
    "issueIds": ["42", "43"],
    "dryRun": false,
    "provider": "copilot",
    "model": "claude-sonnet-4",
    "fastProvider": "copilot",
    "fastModel": "claude-haiku-4",
    "agents": { "planner": { "model": "claude-haiku-4" } },
    "source": "github",
    "concurrency": 4,
    "noPlan": false,
    "noBranch": false,
    "noWorktree": false,
    "retries": 1,
    "force": false
  }
}
```

The worker receives this via `process.on("message")` and calls
`bootOrchestrator()` followed by `orchestrator.orchestrate()` with a
`progressCallback` that sends IPC messages back to the parent.

## Related documentation

- [MCP Tools Overview](./overview.md) — Tool catalog and registration architecture
- [Fork-Run IPC Bridge](./fork-run-ipc.md) — IPC message protocol and process lifecycle
- [Monitor Tools](./monitor-tools.md) — `status_get` and `runs_list` for tracking progress
- [Recovery Tools](./recovery-tools.md) — `run_retry` and `task_retry` for failed runs
- [Config Resolution](./config-resolution.md) — Configuration loading and merging
- [Orchestrator](../cli-orchestration/orchestrator.md) — The pipeline runner
  that executes dispatched tasks
- [Dispatch Pipeline](../cli-orchestration/dispatch-pipeline.md) — The full
  pipeline flow from issue to PR
- [MCP Tools Tests](../testing/mcp-tools-tests.md) — Unit tests for
  `dispatch_run` and `dispatch_dry_run` tool handlers
- [Configuration System](../cli-orchestration/configuration.md) — Persistent
  provider and datasource defaults that feed into `loadMcpConfig()`
