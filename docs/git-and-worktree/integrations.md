# Integrations Reference

This document covers all external dependencies used by the git-and-worktree
helper group. The group integrates with seven external systems: the **GitHub
REST API** via Octokit, the **Azure Identity SDK**, the **Azure DevOps Node
API**, **SQLite** via better-sqlite3, **Zod** for schema validation, the
**Git CLI** for worktree and checkout operations, and the **`open`** package
for cross-platform browser launching.

## GitHub REST API (Octokit)

- **Packages:** `@octokit/rest`, `@octokit/auth-oauth-device`
- **Used in:** `src/helpers/auth.ts:12-13`
- **Official docs:**
    - [@octokit/rest](https://github.com/octokit/rest.js)
    - [@octokit/auth-oauth-device](https://github.com/octokit/auth-oauth-device.js)
    - [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)

### How it is used

The authentication module uses two Octokit packages:

| Package | Function | Purpose |
|---------|----------|---------|
| `@octokit/auth-oauth-device` | `createOAuthDeviceAuth()` | Initiates the OAuth device-code flow, polls GitHub for token completion |
| `@octokit/rest` | `new Octokit({ auth })` | Creates an authenticated REST API client using the obtained token |

`createOAuthDeviceAuth` is configured with:

- `clientId`: The public OAuth App ID (`Ov23liUMP1Oyg811IF58`)
- `clientType`: `"oauth-app"` (not a GitHub App)
- `scopes`: `["repo"]` for full repository access
- `onVerification`: Callback that displays the device code and opens the
  verification URL in the browser

The library handles the polling loop internally — it calls GitHub's token
endpoint at the interval specified in the device-code response until the user
completes authentication or the code expires.

### Token format

GitHub OAuth tokens obtained via the device flow use the `gho_` prefix format
(OAuth user-to-server tokens). These tokens do not expire by default unless
the OAuth App has token expiration enabled. The cached token remains valid
until manually revoked.

### Error conditions

| Condition | Behavior |
|-----------|----------|
| User denies authorization | `createOAuthDeviceAuth` rejects with an error |
| Device code expires (15 min default) | `createOAuthDeviceAuth` rejects with `slow_down` or `expired_token` |
| Invalid client ID | `createOAuthDeviceAuth` rejects immediately |
| Network failure during polling | `createOAuthDeviceAuth` rejects after exhausting retries |

The auth module does not wrap these errors — they propagate to the pipeline
startup, which will terminate the run.

## Azure Identity SDK

- **Package:** `@azure/identity`
- **Class used:** `DeviceCodeCredential`
- **Used in:** `src/helpers/auth.ts:14`
- **Official docs:**
  [DeviceCodeCredential](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/devicecodecredential)

### How it is used

`getAzureConnection` creates a `DeviceCodeCredential` instance with:

- `tenantId`: `"organizations"` — restricts authentication to work/school
  (Entra ID) accounts. Personal Microsoft accounts are explicitly excluded
  because Azure DevOps does not support them for API access.
- `clientId`: `150a3098-01dd-4126-8b10-5e7f77492e5c` — the public Azure AD
  application registration
- `userPromptCallback`: Receives `DeviceCodeInfo` containing the message and
  verification URI. The callback prepends a warning about work/school account
  requirements and routes the message through the auth prompt handler.

After constructing the credential, the module calls:

```
credential.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default")
```

This blocks until the user completes authentication. The returned
`AccessToken` object contains:

- `token`: The bearer token string
- `expiresOnTimestamp`: Unix timestamp (milliseconds) when the token expires

### Token expiry management

Azure tokens have a finite lifetime (typically 1 hour). The auth module caches
the `expiresAt` timestamp and checks it before reuse:

```
expiresAt - Date.now() > EXPIRY_BUFFER_MS  // EXPIRY_BUFFER_MS = 5 * 60 * 1000
```

If the token will expire within 5 minutes, a fresh device-code flow is
triggered. This prevents mid-pipeline authentication failures.

## Azure DevOps Node API

- **Package:** `azure-devops-node-api`
- **Used in:** `src/helpers/auth.ts:15`
- **Official docs:**
  [azure-devops-node-api](https://github.com/microsoft/azure-devops-node-api)

### How it is used

The auth module uses two exports from this package:

| Export | Purpose |
|--------|---------|
| `WebApi` | The API client constructor. Takes an org URL and an auth handler. |
| `getBearerHandler` | Creates an `IRequestHandler` that attaches a bearer token to each request. |

Usage pattern:

```
new azdev.WebApi(orgUrl, azdev.getBearerHandler(token))
```

The `WebApi` instance is returned to the caller (datasource) which uses it
to access Azure DevOps APIs for work items, pull requests, and other resources.
The auth module itself does not call any Azure DevOps API endpoints — it only
constructs the authenticated client.

### Org URL format

The `orgUrl` parameter follows the format `https://dev.azure.com/{organization}`
and is extracted from the git remote URL by `parseAzDevOpsRemoteUrl` in
`src/datasources/index.ts`.

## SQLite via better-sqlite3

- **Package:** `better-sqlite3`
- **Used in:** `src/mcp/state/database.ts` (database layer),
  `src/helpers/run-state.ts` (consumer)
- **Official docs:**
  [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

### Database configuration

The database is a singleton managed by `openDatabase(cwd)` in
`src/mcp/state/database.ts`. It is stored at `{cwd}/.dispatch/dispatch.db`
and configured with three pragmas:

| Pragma | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `WAL` | Write-ahead logging enables concurrent reads during writes |
| `synchronous` | `NORMAL` | Balances durability with performance (fsync on checkpoint, not every commit) |
| `foreign_keys` | `ON` | Enforces the FK from `run_state_tasks.run_id` to `run_state.run_id` |

### API surface used

| API | Used by | Purpose |
|-----|---------|---------|
| `db.exec(sql)` | `ensureRunStateTable` | Execute multi-statement DDL for table creation |
| `db.prepare(sql)` | `loadRunState`, `saveRunState`, `migrateFromJson` | Create prepared statements for parameterized queries |
| `stmt.get(params)` | `loadRunState`, `migrateFromJson` | Fetch a single row |
| `stmt.all(params)` | `loadRunState` | Fetch all matching rows |
| `stmt.run(params)` | `saveRunState` | Execute an INSERT/UPDATE |
| `db.transaction(fn)` | `saveRunState` | Wrap multiple writes in an atomic transaction |

### Synchronous API

`better-sqlite3` uses a synchronous API — all database operations block the
Node.js event loop. This is by design: the library uses N-API bindings to
SQLite's C library and avoids the complexity of async wrappers. For the small
datasets used by run-state (typically < 100 tasks per run), the blocking time
is negligible.

The `run-state.ts` module wraps database access in `async` functions only
because it also performs filesystem I/O (migration) and uses a dynamic
`import()` for lazy loading.

### Lazy import pattern

The run-state module uses a dynamic import to obtain the database:

```typescript
async function getDb(cwd: string) {
    const { openDatabase } = await import("../mcp/state/database.js");
    return openDatabase(cwd);
}
```

This avoids circular dependency issues at module initialization time. The
`database.ts` module may transitively import modules that depend on
`run-state.ts`, so eager import would cause a circular reference.

### Transaction semantics

`saveRunState` wraps all writes in a `db.transaction()` call. In
`better-sqlite3`, this translates to `BEGIN IMMEDIATE` / `COMMIT` statements.
If any operation within the transaction throws, the entire transaction is
rolled back automatically. This guarantees that a partial write (e.g., run
record written but task records not) never persists to disk.

## Zod

- **Package:** `zod`
- **Used in:** `src/helpers/run-state.ts:20`
- **Official docs:** [zod.dev](https://zod.dev/)

### How it is used

Zod provides runtime schema validation at two boundaries:

1. **JSON migration boundary**: When reading the legacy
   `.dispatch/run-state.json` file, `RunStateSchema.safeParse(JSON.parse(raw))`
   validates the entire structure before importing into SQLite. If `safeParse`
   returns `{ success: false }`, the migration is skipped silently — no
   exception is thrown.

2. **SQLite query boundary**: When loading task rows from SQLite,
   `RunStateTaskStatusSchema.safeParse(t.status)` validates each status value
   against the known enum. If an unrecognized status string is found (e.g.,
   from database corruption or schema evolution), the status falls back to
   `"pending"` rather than crashing.

### Schemas defined

| Schema | Type | Fields |
|--------|------|--------|
| `RunStateTaskStatusSchema` | `z.enum` | `["pending", "running", "success", "failed"]` |
| `RunStateTaskSchema` | `z.object` | `{ id, status, branch? }` |
| `RunStateSchema` | `z.object` | `{ runId, preRunSha, tasks[] }` |

Both the `RunState` and `RunStateTask` TypeScript types are derived from
these schemas using `z.infer<>`, making the Zod schemas the single source
of truth for the data shape.

### Why safeParse instead of parse

`safeParse` returns a discriminated union `{ success: true, data } | { success:
false, error }` instead of throwing on validation failure. This is deliberate:

- Migration should be non-disruptive. A malformed legacy file should not crash
  the pipeline — it should be silently skipped.
- Status validation at query time should degrade gracefully. An unknown status
  is treated as `"pending"` (causing re-execution) rather than crashing.

## Git CLI

- **Binary:** `git` (resolved from `$PATH`)
- **Used in:** `src/helpers/worktree.ts`
- **Minimum version:** Git 2.17 (for `git worktree remove`; `add` available
  since 2.5; `list --porcelain` since 2.15)
- **Official docs:** [git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree)

### Commands used

| Command | Function | Purpose |
|---------|----------|---------|
| `git worktree add <path> -b <branch> [startPoint]` | `createWorktree` | Create a worktree with a new branch |
| `git worktree add <path> <branch>` | `createWorktree` (fallback) | Create a worktree on an existing branch |
| `git worktree list --porcelain` | `createWorktree` | Check if a path is a registered worktree |
| `git worktree list` | `listWorktrees` | List all worktrees for diagnostics |
| `git worktree remove <path>` | `removeWorktree` | Remove a clean worktree |
| `git worktree remove --force <path>` | `removeWorktree` (fallback) | Remove a dirty worktree |
| `git worktree prune` | `createWorktree`, `removeWorktree` | Clean up stale admin files |
| `git checkout --force <branch>` | `createWorktree` (reuse path) | Reset worktree to desired branch |
| `git clean -fd` | `createWorktree` (reuse path) | Remove untracked files from worktree |

All commands are executed with `cwd` set to the appropriate directory — the
repository root for worktree management commands, or the worktree path for
`checkout` and `clean`.

### Shell option (Windows)

The internal `git()` helper passes `{ shell: process.platform === "win32" }`
to `execFile`. On Windows, this spawns the git command through `cmd.exe`,
which is necessary because git may be installed as a `.cmd` or `.bat` script
rather than a direct executable. On other platforms, `shell` is `false` and
`execFile` invokes git directly.

### Error messages parsed

The worktree module inspects several error message strings:

| Substring | Used by | Purpose |
|-----------|---------|---------|
| `"already exists"` | `createWorktree` | Branch already exists — retry without `-b` |
| `"already used by worktree"` | `createWorktree` | Stale worktree ref — prune and retry |
| `"lock"` | `createWorktree` | Lock contention — exponential backoff |
| `"already"` (generic) | `createWorktree` | Catch-all retryable condition |

All checks use `String.includes` — substring matches, not exact comparisons.
This is robust across git versions because the core message text has been
stable since these features were introduced.

### Git's internal locking

When multiple worktree operations run concurrently (as happens with
`Promise.all` in the dispatch pipeline), git uses lock files in
`$GIT_DIR/worktrees/` and `$GIT_DIR/refs/` to serialize access to shared
state. The exponential backoff in `createWorktree` specifically handles lock
contention errors that arise from this concurrent access pattern.

### What happens if git is not installed

The [prerequisite checks](../prereqs-and-safety/prereqs.md) verify that the
`git` binary is on `$PATH` before the pipeline starts. If git is missing, the
pipeline exits early with an error message. The worktree module itself does not
check for git availability — it relies on the prereq check.

## Node.js child_process (execFile)

- **Module:** `node:child_process` (built-in)
- **Function used:** `execFile` (via `util.promisify`)
- **Used in:** `src/helpers/worktree.ts:10,18`
- **Official docs:**
  [nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)

### Why execFile instead of exec

The worktree module uses `execFile` rather than `exec`:

| Aspect | `execFile` | `exec` |
|--------|-----------|--------|
| Shell invocation | No shell spawned (except on Windows, see above) | Runs command in a shell |
| Argument injection | Arguments passed as array — no injection risk | Command string is shell-interpreted |
| Performance | Slightly faster (no shell overhead) | Slightly slower |

`execFile` is the correct choice because git arguments (paths, branch names)
may contain characters that require shell escaping. `execFile` avoids this by
passing arguments as an array. Combined with
[branch validation](./branch-validation.md), this provides defense-in-depth
against command injection.

### Promisification

The module uses `util.promisify(execFile)` to convert the callback-based API
into a promise-based function. The promisified version resolves with
`{ stdout, stderr }` on exit code 0 and rejects with an `Error` (including
`stdout`, `stderr`, `code`, and `killed` properties) on non-zero exit.

## open (browser launcher)

- **Package:** `open`
- **Used in:** `src/helpers/auth.ts:16`
- **Official docs:** [sindresorhus/open](https://github.com/sindresorhus/open)

### How it is used

Both `getGithubOctokit` and `getAzureConnection` call
`open(verificationUri).catch(() => {})` to launch the device-code verification
URL in the user's default browser.

### Cross-platform behavior

The `open` package delegates to platform-specific commands:

| Platform | Command |
|----------|---------|
| Linux | `xdg-open` |
| macOS | `open` |
| Windows | `start` |

### Error suppression

The `.catch(() => {})` on every `open()` call silences errors in headless
environments (CI servers, SSH sessions, containers) where no browser or
display server is available. In these cases, the user must manually copy the
verification URL from the terminal output and open it on another device.

## Node.js fs/promises

- **Module:** `node:fs/promises` (built-in)
- **Functions used:** `readFile`, `writeFile`, `mkdir`, `chmod`, `rm`
- **Used in:** `src/helpers/auth.ts:8`, `src/helpers/gitignore.ts:5`,
  `src/helpers/run-state.ts:18`, `src/helpers/worktree.ts:14`

### Usage by module

| Module | Functions | Purpose |
|--------|-----------|---------|
| `auth.ts` | `readFile`, `writeFile`, `mkdir`, `chmod` | Load/save auth cache at `~/.dispatch/auth.json` |
| `gitignore.ts` | `readFile`, `writeFile` | Read and append `.gitignore` entries |
| `run-state.ts` | `readFile`, `mkdir` | Read legacy JSON for migration; ensure `.dispatch/` dir |
| `worktree.ts` | `rm` | Remove stale worktree directories |

### Node.js crypto.randomUUID

- **Module:** `node:crypto` (built-in)
- **Function used:** `randomUUID()`
- **Used in:** `src/helpers/worktree.ts:12`

`generateFeatureBranchName()` uses the first 8-character hex segment (32 bits)
of a UUID v4 for branch names like `dispatch/feature-a1b2c3d4`. See
[Worktree Management — UUID entropy](./worktree-management.md#uuid-entropy-considerations)
for collision analysis.

## Vitest (test framework)

- **Module:** `vitest`
- **Used in:** All test files in this group:
    - `src/tests/branch-validation.test.ts`
    - `src/tests/gitignore.test.ts`
    - `src/tests/worktree.test.ts`
- **Official docs:** [vitest.dev](https://vitest.dev/)

See [Testing](./testing.md) for detailed coverage of test mocking strategy and
what each test file verifies.

## Integration summary

| Integration | Package(s) | Module(s) | Transport |
|-------------|-----------|-----------|-----------|
| GitHub REST API | `@octokit/rest`, `@octokit/auth-oauth-device` | `auth.ts` | HTTPS (OAuth device flow + REST) |
| Azure Identity | `@azure/identity` | `auth.ts` | HTTPS (Entra ID device-code flow) |
| Azure DevOps API | `azure-devops-node-api` | `auth.ts` | HTTPS (bearer token REST) |
| SQLite | `better-sqlite3` | `run-state.ts` via `database.ts` | Local file (WAL mode) |
| Zod | `zod` | `run-state.ts` | In-process (schema validation) |
| Git CLI | `git` binary | `worktree.ts` | Child process (`execFile`) |
| Browser launcher | `open` | `auth.ts` | Platform-specific command |

## Related documentation

- [Overview](./overview.md) — Group-level summary
- [Authentication](./authentication.md) — OAuth flows using Octokit, Azure
  Identity, and Azure DevOps Node API
- [Run State Persistence](./run-state.md) — SQLite schema and Zod validation
  details
- [Worktree Management](./worktree-management.md) — Git CLI command
  orchestration and retry logic
- [Branch Validation](./branch-validation.md) — Branch name validation that
  provides defense-in-depth with `execFile`'s array-based argument passing
- [Gitignore Helper](./gitignore-helper.md) — `fs/promises` usage for
  `.gitignore` manipulation
- [Testing](./testing.md) — Test coverage and mocking strategy for all
  integrations documented here
- [MCP Server — State Management](../mcp-server/state-management.md) — The
  MCP state database shared with run-state
- [Datasource System](../datasource-system/overview.md) — Consumers of the
  authenticated clients created by `auth.ts`
- [Prerequisites — Prereqs](../prereqs-and-safety/prereqs.md) — Git CLI
  availability validation
- [Helpers & Utilities Tests](../testing/helpers-utilities-tests.md) — Tests
  covering shared helper functions used by these integrations
