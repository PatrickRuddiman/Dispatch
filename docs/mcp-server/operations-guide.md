# Operations Guide

This guide covers the operational aspects of running the MCP server: startup
commands, configuration, shutdown behaviour, crash recovery, monitoring, and
database maintenance.

## Starting the server

### Stdio mode (default)

```sh
dispatch mcp
```

The server reads JSON-RPC messages from stdin and writes responses to stdout.
This is the standard mode for MCP client integrations (Claude Desktop, Cursor,
etc.) that launch the server as a subprocess.

To configure an MCP client, point it at the `dispatch mcp` command. For
example, in Claude Desktop's MCP configuration:

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "dispatch",
      "args": ["mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### HTTP mode

```sh
dispatch mcp --http
dispatch mcp --http --port 9110 --host 127.0.0.1
```

The server listens on a TCP port and accepts MCP requests over HTTP. The
default port is 9110 and the default bind address is 127.0.0.1 (localhost
only).

| Flag | Default | Description |
|------|---------|-------------|
| `--http` | (off) | Enable HTTP transport instead of stdio |
| `--port` | `9110` | TCP port to listen on |
| `--host` | `127.0.0.1` | Bind address |

Once running, the server prints:

```
Dispatch MCP server listening on http://127.0.0.1:9110/mcp
Press Ctrl+C to stop.
```

### Health check

In HTTP mode, `GET /health` returns:

```json
{"status": "ok"}
```

Use this endpoint for load balancer or monitoring integration.

## Graceful shutdown

The server installs signal handlers for `SIGINT` (Ctrl+C) and `SIGTERM`.
On receiving either signal, the shutdown sequence is:

1. Close all MCP transports (HTTP mode: close all active session transports;
   stdio mode: close the stdio transport).
2. Close the `McpServer` instance.
3. Close the SQLite database.
4. Exit with code 0.

Each step has independent error handling — a failure in one step does not
prevent the remaining steps from executing. Errors are logged to stderr
(stdio mode) or console.error (HTTP mode).

### Shutdown timing

Shutdown is near-instant for the server itself. However, if a dispatch worker
child process is still running, it will be orphaned. The worker will continue
to run and will exit on its own when the pipeline completes. Since the parent
process has exited, the worker's IPC messages will fail silently (the channel
is closed). The run will remain in `running` status in the database until the
next server startup identifies it as orphaned.

To avoid this, use the recovery tools to cancel active runs before shutting
down, or wait for active pipelines to complete.

## Database location and management

### Location

The SQLite database is stored at:

```
{cwd}/.dispatch/dispatch.db
```

Where `{cwd}` is the working directory passed to the MCP server at startup.
The `.dispatch/` directory is created automatically if it does not exist.

### WAL files

SQLite in WAL (Write-Ahead Logging) mode creates two additional files
alongside the main database:

- `dispatch.db-wal` — The write-ahead log file
- `dispatch.db-shm` — The shared memory file for WAL coordination

These files are normal operational artifacts. They are checkpointed
(merged into the main database) automatically by SQLite. Do not delete
them while the server is running.

### Backup

To back up the database, either:

1. **Copy when stopped**: Copy `dispatch.db` (and its WAL/SHM files) when the
   server is not running.

2. **Copy while running**: SQLite's WAL mode supports safe concurrent reads.
   You can copy the database file while the server is running, but you must
   also copy the `-wal` and `-shm` files atomically with the main file for
   a consistent snapshot.

### Database reset

To start fresh, delete the entire `.dispatch/` directory:

```sh
rm -rf .dispatch/
```

The server will recreate the directory and database on next startup.

### Schema migrations

The database schema is versioned via the `schema_version` table. The current
version is 1. Future Dispatch releases may include schema migrations that run
automatically on server startup. Migrations are forward-only and additive
(adding columns or tables, not removing them).

## Crash recovery

### Server crashes

If the MCP server process crashes (OOM, uncaught exception, SIGKILL), the
SQLite database may have runs stuck in `running` status with no live worker
to complete them. On restart, use the recovery tools to identify and resolve
orphaned runs:

1. List runs with status `running` using the monitor tools.
2. For runs that have no active worker, use the recovery tools to cancel them
   or mark them as failed.

The database itself is safe from corruption because WAL mode provides atomic
commits. A crash during a write will roll back the incomplete transaction
on next open.

### Worker crashes

If a dispatch worker child process crashes (non-zero exit code or signal
kill), the `_fork-run.ts` handler automatically:

1. Marks the run as `failed` with the error message
   `"Worker process exited with code N"`.
2. Emits an error-level log notification to connected MCP clients.
3. Clears the heartbeat interval.

No manual intervention is needed for worker crashes — the run will appear
as `failed` in monitoring queries.

### Orphaned runs

A run is "orphaned" when it is in `running` status in the database but has
no live worker process executing it. This can happen when:

- The server crashes while a worker is running.
- The server is restarted without waiting for active workers to complete.
- A worker exits without sending a done or error message (extremely rare).

The `waitForRunCompletion()` function includes a 2-second DB poll safety net
that can detect orphaned runs. However, the primary recovery mechanism is
manual intervention via the recovery tools.

## Monitoring

### From MCP clients

Connected MCP clients receive real-time progress via MCP logging
notifications. These include:

- Task start/done/failed events with descriptions
- Pipeline phase changes
- 30-second heartbeat messages during long operations
- Error messages with details

The logger name format is `dispatch.run.{runId}`, allowing clients to filter
notifications by run.

### From the database

The SQLite database provides a durable record of all runs and tasks. Query
it directly for historical analysis:

```sh
sqlite3 .dispatch/dispatch.db "SELECT * FROM runs ORDER BY started_at DESC LIMIT 10"
```

Or use the MCP monitor tools programmatically:

- `list_runs` — List recent runs with status and timestamps
- `get_run` — Get details for a specific run including all tasks
- `wait_for_run` — Wait for a run to complete (up to 120 seconds)

### Log levels

The MCP server maps internal log levels to MCP logging levels:

| Internal level | MCP level | Usage |
|----------------|-----------|-------|
| `info` | `info` | Task progress, phase changes, heartbeats |
| `warn` | `warning` | Non-fatal issues |
| `error` | `error` | Task failures, worker crashes, pipeline errors |

### Debug logging

Set the `DEBUG` environment variable to enable verbose logging:

```sh
DEBUG=1 dispatch mcp
```

This enables log callback error reporting in the state manager, which is
normally suppressed to avoid noise from transient notification failures.

## Timeouts and limits

| Parameter | Value | Description |
|-----------|-------|-------------|
| Wait timeout | 120 seconds | Maximum time `waitForRunCompletion()` will block |
| Poll interval | 2 seconds | DB poll frequency during `waitForRunCompletion()` |
| Heartbeat interval | 30 seconds | How often the fork runner emits heartbeat logs |
| Run list limit | 50 (default) | Maximum runs returned by `listRuns()` |
| Status list limit | 20 (default) | Maximum runs returned by `listRunsByStatus()` |
| Spec list limit | 50 (default) | Maximum spec runs returned by `listSpecRuns()` |

The 120-second wait timeout is a hard cap in the code
(`Math.min(waitMs, 120_000)`). Clients that need to track longer-running
operations should poll using `list_runs` or `get_run` periodically rather
than relying on `wait_for_run`.

## Security considerations

### Network binding

In HTTP mode, the server binds to `127.0.0.1` by default, which only accepts
connections from the local machine. The MCP specification recommends this to
prevent DNS rebinding attacks. If you need remote access, change the bind
address with `--host 0.0.0.0`, but be aware of the security implications.

### No authentication

The MCP server does not implement authentication or authorisation. Any process
that can connect to the server can invoke any tool. In HTTP mode, this means
any process on the local machine (or network, if bound to 0.0.0.0) can
dispatch pipelines, cancel runs, or modify configuration.

For production deployments with remote access, place the server behind a
reverse proxy with authentication.

### Session isolation

Each HTTP session gets its own `StreamableHTTPServerTransport` instance.
Sessions share the same `McpServer` and database, so there is no data
isolation between sessions. Any session can see and modify any run or task.

## Troubleshooting

### "Database not open" error

The MCP tool handler called `getDb()` before `openDatabase(cwd)` was called.
This should not happen in normal operation — `openDatabase()` is called at
server startup. If it occurs, it indicates a code path that bypasses the
normal startup sequence.

### Session not found (404)

An HTTP request included an `mcp-session-id` header with a session ID that
is not in the transport map. This can happen when:

- The server was restarted (clearing all session state).
- The session was explicitly deleted via `DELETE /mcp`.
- The session's transport closed due to a connection drop.

The client should start a new session by sending an `InitializeRequest`
without a session ID.

### Worker exits with non-zero code

Check stderr output from the MCP server for the exit code. Common causes:

- **Exit code 1**: Unhandled exception in the worker before the try/catch
  in `handleMessage()` (e.g., module import failure).
- **Exit code null**: The worker was killed by a signal (e.g., OOM killer,
  manual SIGKILL).

The run will be automatically marked as `failed` in the database.

### Heartbeat messages stop but run is still "running"

The worker process may have hung (infinite loop, deadlocked AI provider).
The heartbeat interval is cleared only on worker exit, so a hung worker
will continue emitting heartbeats as long as the parent process is alive.
If heartbeats stop but the run status is still `running`, the parent
process may have crashed or the SSE connection was dropped.

Check the server process status and use the recovery tools to cancel the
orphaned run.

## Related documentation

- [Overview](./overview.md) — MCP server architecture and design decisions
- [State Management](./state-management.md) — Database schema and CRUD
  operations
- [Server Transports](./server-transports.md) — Transport modes and session
  lifecycle
- [Dispatch Worker](./dispatch-worker.md) — Worker process lifecycle and
  crash handling
- [Monitor Tools](../mcp-tools/monitor-tools.md) — `status_get`, `runs_list`,
  `issues_list`, and `issues_fetch` tools for querying run state
- [Recovery Tools](../mcp-tools/recovery-tools.md) — `run_retry` and
  `task_retry` tools for recovering from failures
- [Config Resolution](../mcp-tools/config-resolution.md) — How MCP tools
  resolve provider and datasource configuration
