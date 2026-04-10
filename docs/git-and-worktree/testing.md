# Testing Guide

The git-and-worktree group has comprehensive unit test coverage across three
test files using [Vitest](https://vitest.dev/) with module-level mocking of
all external dependencies.

## Test files

| Test file | Module under test | Tests |
|-----------|-------------------|-------|
| `src/tests/branch-validation.test.ts` | `helpers/branch-validation.ts` | 41 |
| `src/tests/gitignore.test.ts` | `helpers/gitignore.ts` | 8 |
| `src/tests/worktree.test.ts` | `helpers/worktree.ts` | 25 |

## Running the tests

```bash
# Run all git-and-worktree tests
npx vitest run tests/branch-validation.test.ts tests/gitignore.test.ts tests/worktree.test.ts

# Run a single test file
npx vitest run tests/worktree.test.ts

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
| `node:fs/promises` | `readFile`, `writeFile` | Returns strings or rejects per test |
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
- [Branch Validation](./branch-validation.md) — What the validation tests verify
- [Worktree Management](./worktree-management.md) — The creation/removal
  lifecycle that worktree tests exercise
- [Gitignore Helper](./gitignore-helper.md) — The deduplication and error
  handling that gitignore tests verify
- [Testing Overview](../testing/overview.md) — Project-wide test framework and
  conventions
- [Shared Utilities Testing](../shared-utilities/testing.md) — Fake timer
  patterns and pure-function testing patterns used across the project
- [Test Fixtures](../testing/test-fixtures.md) — Shared mock factories
  including `createMockChildProcess()` used in related test suites
