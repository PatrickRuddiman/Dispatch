# Testing Guide

The git-and-worktree group has comprehensive unit test coverage across five
test files using [Vitest](https://vitest.dev/) with module-level mocking of
all external dependencies.

## Test files

| Test file | Module under test | Tests |
|-----------|-------------------|-------|
| `src/tests/auth.test.ts` | `helpers/auth.ts` | 18 |
| `src/tests/branch-validation.test.ts` | `helpers/branch-validation.ts` | 41 |
| `src/tests/gitignore.test.ts` | `helpers/gitignore.ts` | 8 |
| `src/tests/run-state.test.ts` | `helpers/run-state.ts` | 9 |
| `src/tests/worktree.test.ts` | `helpers/worktree.ts` | 25 |

## Running the tests

```bash
# Run all git-and-worktree tests
npx vitest run tests/auth.test.ts tests/branch-validation.test.ts tests/gitignore.test.ts tests/run-state.test.ts tests/worktree.test.ts

# Run a single test file
npx vitest run tests/auth.test.ts

# Run in watch mode
npx vitest tests/worktree.test.ts
```

## Mocking strategy

All three test files follow the same pattern for isolating external
dependencies:

### Mock setup with `vi.hoisted`

Mocks are defined inside `vi.hoisted()` blocks, which Vitest hoists above all
imports. This ensures mock implementations are available before the module
under test is loaded:

```typescript
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));
```

### Module-level `vi.mock`

External modules are replaced at the module level:

| Dependency | Mock target | Strategy |
|------------|-------------|----------|
| `node:child_process` | `execFile` | Returns `{ stdout }` objects or rejects |
| `node:util` | `promisify` | Returns the mock `execFile` directly |
| `node:fs/promises` | `readFile`, `writeFile`, `mkdir`, `chmod` | Returns strings or rejects per test |
| `node:os` | `homedir` | Returns a fake home directory |
| `@octokit/rest` | `Octokit` | Constructor spy returning mock instance |
| `@octokit/auth-oauth-device` | `createOAuthDeviceAuth` | Returns mock auth function |
| `@azure/identity` | `DeviceCodeCredential` | Constructor spy returning mock credential |
| `azure-devops-node-api` | `WebApi`, `getBearerHandler` | Constructor spy and bearer handler factory |
| `open` | default export | No-op mock resolving to `undefined` |
| `../mcp/state/database.js` | `openDatabase` | Returns mock DB object with `exec`, `prepare`, `transaction` |
| `../datasources/index.js` | `getGitRemoteUrl`, `parseGitHubRemoteUrl`, `parseAzDevOpsRemoteUrl` | Return values configured per test |
| `helpers/logger.js` | `log.*` methods | No-op spies with `formatErrorChain` returning the message |

### Reset between tests

All test files use `beforeEach` to reset mocks and `afterEach` to restore all
mocks:

```typescript
beforeEach(() => {
  mockExecFile.mockReset();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

## Authentication tests

The authentication tests (`src/tests/auth.test.ts`) mock all external
dependencies — Octokit, Azure Identity, Azure DevOps Node API, `open`,
`fs/promises`, and datasource URL parsers.

### Test groups

| Group | Tests | Coverage |
|-------|-------|----------|
| `getGithubOctokit` | 3 | Cached token reuse, device flow initiation, missing github key in cache |
| `getAzureConnection` | 5 | Cached token reuse, device flow initiation, expired token refresh, near-expiry buffer, null token error |
| Auth cache file operations | 4 | `mkdir` recursive, chmod 0o600 on non-Windows, skip chmod on Windows, chmod failure tolerance |
| Auth prompt handler | 3 | GitHub prompt routing, Azure prompt routing (with work/school note), log.info fallback |
| `ensureAuthReady` | 8 | GitHub with valid remote, no remote, non-GitHub remote; Azure with explicit org, org from remote, no remote, non-Azure remote; markdown/undefined datasource no-ops |

### Key assertions

- Verifies the exact GitHub client ID (`Ov23liUMP1Oyg811IF58`) is passed to
  `createOAuthDeviceAuth`
- Verifies the Azure DevOps scope
  (`499b84ac-1321-427f-aa17-267ca6975798/.default`) is passed to `getToken`
- Confirms tokens are written to `~/.dispatch/auth.json` with correct
  structure
- Validates the 5-minute expiry buffer by testing with a token expiring in 2
  minutes (should trigger re-auth)
- Tests platform-specific behavior: `chmod` skipped on Windows, called with
  `0o600` on other platforms
- Verifies `open()` is called with the verification URI

## Run-state tests

The run-state tests (`src/tests/run-state.test.ts`) mock the SQLite database
layer via a fake `openDatabase` that returns a mock DB object with `exec`,
`prepare`, and `transaction` methods.

### Test groups

| Group | Tests | Coverage |
|-------|-------|----------|
| `loadRunState` | 3 | Returns null when no DB row, returns parsed RunState from DB rows, falls back to "pending" for unrecognized status |
| `saveRunState` | 1 | Creates directory, bootstraps tables, runs transactional upsert |
| `buildTaskId` | 2 | basename:line format, handles files with no directory |
| `shouldSkipTask` | 6 | Skips on "success", re-executes on "failed"/"pending"/"running", not found in state, null state |

### Key assertions

- Validates the Zod status fallback: an `"UNKNOWN"` status in the database
  is silently replaced with `"pending"`
- Confirms `mkdir` is called with `{ recursive: true }` for the `.dispatch`
  directory
- Verifies `db.exec` is called for table bootstrap and `db.transaction` is
  used for writes
- Tests that `buildTaskId` strips the directory path and uses only the
  basename with line number

## Branch validation tests

The branch validation tests (`src/tests/branch-validation.test.ts`) are
pure-function tests with no mocks — they test the validator and error class
directly.

### Test groups

| Group | Focus |
|-------|-------|
| Valid branch names | Confirms acceptance of simple names, slashes, dots, underscores, max length (255) |
| Empty and overlength | Boundary conditions: empty string, 256 characters |
| Invalid characters | Shell metacharacters (`$(whoami)`), spaces, colons, tildes, carets, backslashes, wildcards |
| Git refname rules | Leading/trailing slashes, `..`, `.lock`, `@{`, `//` |
| `InvalidBranchNameError` | `instanceof Error`, `name` property, message formatting |
| `VALID_BRANCH_NAME_RE` | Direct regex testing against valid and invalid character sets |

## Gitignore tests

The gitignore tests (`src/tests/gitignore.test.ts`) mock `readFile` and
`writeFile` from `node:fs/promises`.

### Test coverage

| Scenario | Assertions |
|----------|------------|
| Entry already exists (LF) | `writeFile` not called |
| Entry already exists (CRLF) | `writeFile` not called |
| Bare form already exists | `writeFile` not called (`.dispatch/worktrees` matches `.dispatch/worktrees/`) |
| Slash form already exists | `writeFile` not called |
| File does not exist (ENOENT) | Creates file with entry |
| File lacks trailing newline | Prepends newline separator |
| Write failure | Logs warning, does not throw |
| Non-ENOENT read failure | Logs warning, returns without writing |

## Worktree tests

The worktree tests (`src/tests/worktree.test.ts`) mock `execFile` to simulate
git subprocess interactions.

### `worktreeName` tests

| Input | Expected output | Tests |
|-------|----------------|-------|
| `123-fix-auth-bug.md` | `issue-123` | Numeric ID extraction |
| `/tmp/dispatch-abc/123-fix.md` | `issue-123` | Full path handling |
| `123-some-title` | `issue-123` | No `.md` extension |
| `123-Fix Auth Bug!.md` | `issue-123` | Special characters |
| `456-test.MD` | `issue-456` | Case-insensitive extension |
| `no-number-here.md` | `no-number-here` | Slugify fallback |

### `createWorktree` tests

| Scenario | Behavior verified |
|----------|-------------------|
| Normal creation | Calls `git worktree add <path> -b <branch>` |
| Path returned | Returns absolute worktree path |
| Branch exists | Retries without `-b` flag |
| Other error | Throws the error |
| Debug logging | Logs on both new and existing branch paths |

### `removeWorktree` tests

| Scenario | Behavior verified |
|----------|-------------------|
| Normal removal | `git worktree remove` + `git worktree prune` |
| Force fallback | Uses `--force` when normal remove fails |
| Both fail | Warns, does not throw |
| No prune on failure | Skips prune when both removal attempts fail |
| Prune failure | Warns, does not throw |
| Prune after force | Prunes after successful force removal |

### `generateFeatureBranchName` tests

| Scenario | Assertion |
|----------|-----------|
| Format | Matches `/^dispatch\/feature-[0-9a-f]{8}$/` |
| Uniqueness | Two successive calls produce different names |

## Related documentation

- [Overview](./overview.md) — Group-level summary
- [Authentication](./authentication.md) — OAuth flows verified by auth tests
- [Branch Validation](./branch-validation.md) — What the validation tests verify
- [Worktree Management](./worktree-management.md) — The creation/removal
  lifecycle that worktree tests exercise
- [Run State Persistence](./run-state.md) — SQLite persistence and Zod
  validation verified by run-state tests
- [Gitignore Helper](./gitignore-helper.md) — The deduplication and error
  handling that gitignore tests verify
- [Integrations](./integrations.md) — External dependencies mocked in tests
- [Worktree Tests (testing section)](../testing/worktree-tests.md) — Additional
  worktree test documentation in the project-wide testing section
- [Planner & Executor Tests](../testing/planner-executor-tests.md) — Agent
  tests that exercise worktree isolation passthrough, validating the worktree
  path is forwarded correctly to providers
