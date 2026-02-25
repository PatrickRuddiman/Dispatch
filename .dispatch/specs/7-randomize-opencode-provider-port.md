# Randomize OpenCode Provider Port (#7)

> Prevent port collisions when multiple Dispatch instances run concurrently by using an OS-assigned ephemeral port for the OpenCode server, and ensure the spawned server process is always cleaned up -- even on unexpected termination via signals or unhandled errors.

## Context

Dispatch is a TypeScript CLI tool that orchestrates AI coding agents. The project is ESM-only TypeScript (ES2022 target, Node.js 18+), built with tsup (single entry point `src/cli.ts` bundled to `dist/cli.js`), tested with Vitest, and uses npm as its package manager. There is no external CLI framework -- argument parsing and lifecycle management are hand-rolled in `src/cli.ts`.

The codebase has a **provider system** that abstracts AI agent backends behind the `ProviderInstance` interface (`src/provider.ts`). Providers are registered in a boot-function registry (`src/providers/index.ts`) and expose `createSession()`, `prompt()`, and `cleanup()` methods. The `cleanup()` contract is documented as "safe to call multiple times."

The **OpenCode provider** (`src/providers/opencode.ts`) wraps `@opencode-ai/sdk`. Its `boot()` function has two code paths:
- **External server** (`opts.url` provided): creates only an HTTP client via `createOpencodeClient()`. No child process is spawned, so cleanup is a no-op.
- **Auto-spawn** (no `opts.url`): calls `createOpencode()` from the SDK, which internally calls `createOpencodeServer()`. This spawns an `opencode serve` child process. The SDK defaults to `port: 4096` when no port option is passed. The returned `server.close()` method sends `SIGTERM` to the child process.

The **CLI** (`src/cli.ts`) has two operational modes:
- **Dispatch mode**: calls `bootOrchestrator()` then `orchestrator.orchestrate()` (in `src/agents/orchestrator.ts`), which boots the provider, runs tasks, and calls `instance.cleanup()` at the end of its happy path. The CLI then calls `orchestrator.cleanup()` (a no-op).
- **Spec mode** (`--spec`): calls `generateSpecs()` (in `src/spec-generator.ts`), which boots the provider, generates specs, and calls `instance.cleanup()` at the end.

Both modes exit via `process.exit()`. An unhandled error in `main()` is caught by `main().catch()`, which logs the error and calls `process.exit(1)` **without any cleanup**.

There are **no process signal handlers** anywhere in the codebase -- no `SIGINT`, `SIGTERM`, `uncaughtException`, or `unhandledRejection` handlers. If the user presses Ctrl+C or the process is killed externally, the spawned `opencode serve` child process is orphaned.

Additionally, the current OpenCode `cleanup()` implementation calls `stopServer?.()` without any idempotency guard. While the interface documents it as safe to call multiple times, the implementation does not enforce this -- calling `server.close()` (which calls `proc.kill()`) twice could produce warnings or errors.

The **Copilot provider** (`src/providers/copilot.ts`) demonstrates a more robust cleanup pattern: it tracks sessions in a Map, destroys them with `.catch(() => {})` error swallowing, and calls `client.stop().catch(() => {})`.

Key files:
- `src/providers/opencode.ts` -- OpenCode provider boot and cleanup
- `src/cli.ts` -- CLI entry point, process lifecycle, error handling
- `src/agents/orchestrator.ts` -- dispatch mode pipeline, provider cleanup on happy path
- `src/spec-generator.ts` -- spec mode pipeline, provider cleanup on happy path
- `src/provider.ts` -- `ProviderInstance` interface definition
- `src/logger.ts` -- structured logger (`log` utility) used throughout
- `node_modules/@opencode-ai/sdk/dist/server.js` -- SDK server spawn logic, default port 4096
- `node_modules/@opencode-ai/sdk/dist/index.js` -- `createOpencode()` wrapper that passes options through to `createOpencodeServer()`

## Why

**Port collisions block concurrent workflows.** When a user runs two or more Dispatch processes simultaneously (e.g., dispatching tasks in one terminal while generating specs in another), both attempt to bind port 4096. The second instance fails because the port is already in use. This is a blocking usability issue with no workaround other than waiting for the first process to finish.

**Orphaned server processes cause cascading failures.** If the CLI is interrupted with Ctrl+C, killed by the OS, or hits an unhandled error in `main()`, the spawned `opencode serve` child process is never terminated. It continues to hold port 4096, blocking all subsequent Dispatch runs. The user sees a cryptic port-in-use error with no guidance on what went wrong or how to fix it. They must manually find and kill the orphaned process.

**Both problems are coupled.** Randomizing the port prevents collisions, but without cleanup on signals/errors, orphaned servers still accumulate (just on random ports instead of 4096). Conversely, perfect cleanup without port randomization still fails when two processes start simultaneously and race for the same port. Both fixes must be delivered together.

## Approach

### 1. Use an ephemeral port via `{ port: 0 }`

In the OpenCode provider's `boot()` function, pass `{ port: 0 }` to `createOpencode()`. The SDK passes this through to `createOpencodeServer()`, which spawns `opencode serve --port=0`. The OS assigns a random available port. The SDK already handles this correctly -- it parses the actual listening URL from the child process's stdout and returns it in `server.url`, which is then used to create the client. No additional port-finding logic is needed; no race conditions are possible.

Only the auto-spawn code path (the `else` branch in `boot()`) is affected. The `--server-url` path remains unchanged.

### 2. Make cleanup idempotent with a boolean guard

Add a `cleaned` boolean flag (initially `false`) in the OpenCode provider's `boot()` closure. When `cleanup()` is called, check the flag: if already `true`, return immediately; otherwise, set it to `true` and call `stopServer?.()`. This makes the implementation honor the `ProviderInstance` interface's documented contract that `cleanup()` is safe to call multiple times. This is critical because signal handlers and normal-flow cleanup may both trigger in sequence.

### 3. Register process signal handlers in `src/cli.ts`

The challenge is that the provider instance is created deep inside `orchestrate()` or `generateSpecs()`, not in `main()` directly. The recommended approach is a **module-level cleanup registry** -- a simple mechanism that allows any code to register a cleanup function, and that gets drained on process signals and errors.

Specifically:
- Create a small cleanup registry (an array of async cleanup functions, or a single settable cleanup callback) accessible from `src/cli.ts`.
- In `src/cli.ts`, register `SIGINT` and `SIGTERM` handlers early in `main()` that invoke the registered cleanup, then exit with the conventional Unix codes (130 for SIGINT, 143 for SIGTERM).
- Modify the `main().catch()` error handler to also invoke cleanup before calling `process.exit(1)`.
- In `src/providers/opencode.ts` (or the calling code in `orchestrate()`/`generateSpecs()`), register the provider's `cleanup()` with the registry when the provider boots.

The cleanup registry could live as a simple exported function pair (`registerCleanup`/`runCleanup`) in a utility module, or it could be inlined directly in `src/cli.ts` as a module-level variable. The key constraint is that the provider instance (created in sub-modules) must be able to register its cleanup with the CLI-level signal handlers.

The idempotency guard from task 2 provides a safety net: if both the signal handler and the normal-flow cleanup invoke `provider.cleanup()`, the second call is harmlessly a no-op.

### 4. Ensure error paths also clean up

The `orchestrate()` method in `src/agents/orchestrator.ts` has a `catch` block that only calls `tui.stop()` before re-throwing. If an error occurs after the provider is booted but before normal cleanup, the provider is leaked. Similarly in `generateSpecs()`. The signal handler registry approach covers this implicitly (the handler fires regardless of where in the pipeline the error occurred), but the `try/catch` blocks should also be reviewed to ensure they invoke cleanup in their error paths.

### Patterns to follow

- Use the `log` utility from `src/logger.ts` for any debug-level output (e.g., "Signal received, cleaning up...")
- Follow the closure-based pattern used by the OpenCode provider (it returns an object literal, not a class instance, with closures over local state)
- Follow the error-swallowing pattern from the Copilot provider for cleanup operations (`.catch(() => {})`) to prevent cleanup errors from masking the original error
- Use `process.on("SIGINT", ...)` and `process.on("SIGTERM", ...)` which are the standard Node.js mechanisms for signal handling

## Integration Points

- **`ProviderInstance` interface** (`src/provider.ts`): `cleanup()` is already documented as safe for multiple calls. No interface changes needed, but the OpenCode implementation must honor this.

- **`@opencode-ai/sdk` `ServerOptions`**: The `port` field accepts a `number`. Passing `0` delegates to OS ephemeral port assignment. The SDK's `createOpencodeServer()` spawns `opencode serve --port=0` and reads the actual URL from stdout. The `createOpencode()` wrapper passes options through transparently.

- **`ProviderBootOptions`** (`src/provider.ts`): No changes needed. The `url` field is only used for `--server-url` mode. Port randomization applies only to the auto-spawn path.

- **CLI lifecycle** (`src/cli.ts`): Signal handlers must integrate with the existing `main()` structure. Exit code conventions: 0 on success, 1 on task failures, 130 on SIGINT, 143 on SIGTERM. The `main().catch()` error handler must also invoke cleanup.

- **Orchestrator cleanup** (`src/agents/orchestrator.ts`): Already calls `instance.cleanup()` within `orchestrate()` on the happy path. Signal handlers at the CLI level must not conflict with this existing cleanup -- the idempotency guard ensures safety.

- **Spec generator cleanup** (`src/spec-generator.ts`): Already calls `instance.cleanup()` at the end. Same non-conflict requirement.

- **Build system**: `tsup` bundles `src/cli.ts` as the single entry point. No config changes needed.

- **Test framework**: Vitest. Any new tests should follow the patterns in `src/parser.test.ts`. The test runner is invoked via `npm run test`.

- **Logger** (`src/logger.ts`): Use `log.debug()` for signal-handling trace output. The logger is the standard logging mechanism throughout the project.

## Tasks

- [x] (P) Randomize the OpenCode server port -- In `src/providers/opencode.ts`, pass `{ port: 0 }` to `createOpencode()` in the auto-spawn code path so each Dispatch instance gets a unique, OS-assigned port. This eliminates port collisions when multiple instances run concurrently. Only the `else` branch in `boot()` (where no `opts.url` is provided) should be changed; the `--server-url` path must remain untouched.

- [x] (P) Guard cleanup against double invocation -- In `src/providers/opencode.ts`, add a boolean idempotency guard to the `cleanup()` closure so that `server.close()` is called at most once. This prevents errors or warnings when both signal handlers and normal-flow cleanup trigger in sequence. The guard should be a simple `cleaned` flag within the `boot()` closure scope. This makes the OpenCode implementation honor the `ProviderInstance` interface's documented contract.

- [x] (S) Register process signal handlers for graceful shutdown -- In `src/cli.ts`, add `SIGINT` and `SIGTERM` handlers that ensure the spawned provider server is cleaned up before the process exits. This requires making a cleanup function accessible to signal handlers -- either via a module-level cleanup registry or by restructuring `main()` so the provider's cleanup is reachable at the top level. The handlers should exit with conventional Unix codes (130 for SIGINT, 143 for SIGTERM). The `main().catch()` error handler should also invoke cleanup before exiting. The mechanism must allow sub-modules (`orchestrate()`, `generateSpecs()`) to register their provider's cleanup function when the provider boots. Use `log.debug()` for any trace output about signal handling.

- [ ] (S) Verify the fix end-to-end -- Confirm the project builds cleanly (`npm run build`), passes type checking (`npm run typecheck`), and passes existing tests (`npm run test`). Ensure the changes do not break any existing behavior.

## References

- GitHub Issue: https://github.com/PatrickRuddiman/Dispatch/issues/7
- `@opencode-ai/sdk` `ServerOptions` type: `node_modules/@opencode-ai/sdk/dist/server.d.ts` -- documents `port?: number` with default `4096`
- `@opencode-ai/sdk` server implementation: `node_modules/@opencode-ai/sdk/dist/server.js` -- shows `proc.kill()` in `close()` and default options merge with `port: 4096`
- `@opencode-ai/sdk` `createOpencode()` wrapper: `node_modules/@opencode-ai/sdk/dist/index.js` -- passes options through to `createOpencodeServer()`
- Node.js signal events documentation: https://nodejs.org/api/process.html#signal-events
- Unix signal exit code convention: exit code = 128 + signal number (SIGINT=2 -> 130, SIGTERM=15 -> 143)
