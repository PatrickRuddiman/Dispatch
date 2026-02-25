# Randomize OpenCode Provider Port (#7)

> Prevent port collisions when multiple Dispatch instances run concurrently by using an ephemeral port for the OpenCode server, and ensure the spawned server process is always cleaned up — even on unexpected termination.

## Context

Dispatch is a TypeScript CLI tool (`src/cli.ts`) that orchestrates AI coding agents. It has two operational modes — **dispatch mode** (process markdown task files) and **spec mode** (`--spec`). Both modes boot an AI provider via the provider registry at `src/providers/index.ts`, which delegates to backend-specific boot functions.

The **OpenCode provider** (`src/providers/opencode.ts`) wraps `@opencode-ai/sdk`. Its `boot()` function either connects to an existing server (when `--server-url` is supplied) or spawns a local server via the SDK's `createOpencode()` factory. That factory accepts an optional `ServerOptions` object with a `port` field that **defaults to 4096** when omitted. The returned object exposes `server.close()` which sends `SIGTERM` to the spawned child process.

The **cleanup lifecycle** has three distinct code paths that call `provider.cleanup()`:

1. **Dispatch mode** (`src/cli.ts` → `orchestrator.orchestrate()` in `src/agents/orchestrator.ts`) — `instance.cleanup()` is called at the end of the `orchestrate()` method, then `orchestrator.cleanup()` is called by the CLI.
2. **Spec mode** (`src/cli.ts` → `generateSpecs()` in `src/spec-generator.ts`) — `instance.cleanup()` is called at the end of `generateSpecs()`.
3. **Unhandled error** (`src/cli.ts`, `main().catch()`) — calls `process.exit(1)` directly without any cleanup.

None of these paths handle process signals (`SIGINT`, `SIGTERM`) or unexpected crashes, meaning the spawned `opencode serve` child process is orphaned if the user presses Ctrl+C or the process is killed externally.

Key files involved:

- `src/providers/opencode.ts` — the OpenCode boot function and cleanup logic
- `src/cli.ts` — CLI entry point, the only place where the full process lifecycle is visible
- `src/agents/orchestrator.ts` — dispatch-mode pipeline with provider cleanup
- `src/spec-generator.ts` — spec-mode pipeline with provider cleanup
- `src/provider.ts` — the `ProviderInstance` interface (documents `cleanup()` as "safe to call multiple times")
- `@opencode-ai/sdk` — `createOpencode(options?: ServerOptions)` where `ServerOptions.port` defaults to `4096`

## Why

**Port collisions:** When a user runs two or more Dispatch processes at the same time (e.g., dispatching tasks in one terminal while generating specs in another), both attempt to bind port 4096. The second instance fails because the port is already in use. This is a blocking usability issue for concurrent workflows.

**Orphaned server processes:** If the CLI is interrupted with Ctrl+C, killed by the OS, or hits an unhandled error in `main()`, the spawned `opencode serve` child process is never terminated. It continues to hold port 4096, blocking subsequent Dispatch runs until the user manually kills it. This is particularly insidious because there is no error message explaining why the next run fails — the user just sees a cryptic port-in-use error.

Both problems must be solved together: randomizing the port prevents collisions, and proper signal handling ensures the server is always cleaned up regardless of how the CLI exits.

## Approach

### 1. Use an ephemeral port (port `0`)

Pass `{ port: 0 }` to `createOpencode()` in the OpenCode provider's `boot()` function. The SDK's internal `createOpencodeServer` spawns `opencode serve --port=0`, and the OS assigns a random available port. The SDK already handles this — it reads the actual listening URL from the child process's stdout and returns it in `server.url`, which is then passed to `createOpencodeClient({ baseUrl: server.url })`. No changes are needed beyond passing the option.

This is the simplest and most robust approach: no need to implement port-finding logic, no race conditions between checking availability and binding.

### 2. Make cleanup idempotent with a guard

The `ProviderInstance` interface documents `cleanup()` as "safe to call multiple times," but the current OpenCode implementation calls `stopServer?.()` without tracking whether it has already been called. Add a boolean guard so that `server.close()` (which sends `SIGTERM` to the child process) is only invoked once, preventing double-kill warnings or errors when signal handlers and normal cleanup both trigger.

### 3. Register process signal handlers in the CLI

Add `SIGINT` and `SIGTERM` handlers in `src/cli.ts` that ensure cleanup runs before the process exits. The challenge is that the provider instance is created deep inside `orchestrate()` or `generateSpecs()`, not in `main()` directly. There are two viable strategies:

- **Strategy A (recommended):** Refactor `main()` so the provider instance (or a cleanup callback) is accessible at the top level, then register signal handlers that invoke cleanup before calling `process.exit()`. This could involve having `generateSpecs` and the orchestrator expose or accept a cleanup hook.
- **Strategy B:** Use a module-level cleanup registry — a simple array of cleanup functions that gets populated when providers boot, and drained on signal. Less elegant but requires fewer interface changes.

The chosen strategy should ensure that:
- Signal handlers call cleanup then exit with the appropriate code (130 for SIGINT, 143 for SIGTERM per Unix convention)
- The `main().catch()` error handler also invokes cleanup before exiting
- Cleanup is not called twice in the happy path (the idempotency guard from task 2 provides a safety net)

### 4. Align with existing patterns

- The project uses no external CLI framework — argument parsing and lifecycle management are hand-rolled in `src/cli.ts`
- The `ProviderInstance` interface already declares `cleanup()` as multiply-callable, so the idempotency guard is consistent with the documented contract
- The project is ESM-only TypeScript targeting Node.js 18+, so `process.on("SIGINT", ...)` is the standard mechanism
- The `log` utility from `src/logger.ts` should be used for any debug-level output about signal handling

## Integration Points

- **`ProviderInstance` interface** (`src/provider.ts`) — `cleanup()` is already documented as safe for multiple calls; no interface changes needed, but the implementation must honor this
- **`@opencode-ai/sdk` `ServerOptions`** — the `port` field accepts a `number`; passing `0` delegates to OS ephemeral port assignment. The SDK's server startup flow reads the actual port from stdout, so `server.url` will contain the correct dynamically-assigned URL
- **`ProviderBootOptions`** (`src/provider.ts`) — no changes needed; `url` is only used for `--server-url` mode, and the port randomization applies only to the auto-spawn path
- **CLI lifecycle** (`src/cli.ts`) — signal handlers must integrate with the existing `main()` structure without breaking the current exit-code logic (exit 0 on success, exit 1 on failures)
- **Orchestrator cleanup** (`src/agents/orchestrator.ts`) — already calls `instance.cleanup()` within `orchestrate()`; if signal handlers are added at the CLI level, they should not conflict with this existing cleanup
- **Spec generator cleanup** (`src/spec-generator.ts`) — already calls `instance.cleanup()` at the end; same non-conflict requirement
- **Build system** — `tsup` bundles `src/cli.ts` as the single entry point; no config changes needed
- **Test framework** — Vitest; any new tests should follow the patterns in `src/parser.test.ts`

## Tasks

- [ ] Randomize the OpenCode server port — In `src/providers/opencode.ts`, pass `{ port: 0 }` (or a random ephemeral port) to `createOpencode()` so each Dispatch instance gets a unique, OS-assigned port. This eliminates port collisions when multiple instances run concurrently. Only the auto-spawn code path (the `else` branch in `boot()`) is affected; the `--server-url` path should remain unchanged.

- [ ] Guard cleanup against double invocation — In `src/providers/opencode.ts`, add an idempotency guard to the `cleanup()` method so that `server.close()` is called at most once. This prevents errors or warnings when both signal handlers and normal-flow cleanup trigger in sequence. The `ProviderInstance` interface already documents `cleanup()` as safe to call multiple times — this task makes the OpenCode implementation honor that contract.

- [ ] Register process signal handlers for graceful shutdown — In `src/cli.ts`, ensure that `SIGINT` and `SIGTERM` cause the spawned provider server to be cleaned up before the process exits. This requires making a cleanup function accessible to signal handlers, which may involve light restructuring of how `main()` coordinates with `generateSpecs()` and `orchestrate()`. The handlers should exit with conventional codes (130 for SIGINT, 143 for SIGTERM). The `main().catch()` error path should also invoke cleanup.

- [ ] Verify the fix end-to-end — Confirm that the project builds cleanly (`npm run build`), passes type checking (`npm run typecheck`), and passes existing tests (`npm run test`). Manually verify (or write a test) that two concurrent Dispatch processes can boot OpenCode servers without port conflicts, and that Ctrl+C properly terminates the spawned server process.

## References

- GitHub Issue: https://github.com/PatrickRuddiman/Dispatch/issues/7
- `@opencode-ai/sdk` `ServerOptions` type: `node_modules/@opencode-ai/sdk/dist/server.d.ts` — documents `port?: number` with default `4096`
- `@opencode-ai/sdk` server implementation: `node_modules/@opencode-ai/sdk/dist/server.js` — shows `proc.kill()` in `close()` and default options merge
- Node.js `process.on("SIGINT")` documentation: https://nodejs.org/api/process.html#signal-events
- Unix signal exit codes convention: exit code = 128 + signal number (SIGINT=2 → 130, SIGTERM=15 → 143)
