# Branch Name Validation

The branch validation module (`src/helpers/branch-validation.ts`) enforces git
refname rules on branch names used throughout Dispatch. It provides a validator
function, a strict character-set regex, and a typed error class — shared by all
three datasource implementations to ensure consistent branch name safety.

## What it does

The module exports three items:

| Export | Type | Purpose |
|--------|------|---------|
| `isValidBranchName(name)` | `(string) => boolean` | Validates a branch name against git refname rules |
| `VALID_BRANCH_NAME_RE` | `RegExp` | Character-set regex: `/^[a-zA-Z0-9._\-/]+$/` |
| `InvalidBranchNameError` | `class extends Error` | Typed error with branch name context |

## Why it exists

Branch names in Dispatch flow from multiple sources — datasource-generated
names (`<username>/dispatch/<number>-<slug>`), feature branch names
(`dispatch/feature-<octet>`), and default branch names read from
`git symbolic-ref`. Without validation, a malicious or malformed branch name
could cause command injection when passed to `git` or `gh` CLI subprocess
calls, or violate git's own refname constraints and cause cryptic errors.

The module was extracted from the [GitHub datasource](../datasource-system/github-datasource.md) so that all datasource
implementations ([GitHub](../datasource-system/github-datasource.md), [Azure DevOps](../datasource-system/azdevops-datasource.md), [Markdown](../datasource-system/markdown-datasource.md)) share identical validation
logic.

## How it works

`isValidBranchName(name)` applies seven checks in sequence. A name must pass
all checks to be considered valid:

| Check | Rule | Git refname reference |
|-------|------|----------------------|
| Length | 1–255 characters | Rule: refs must not be empty |
| Character set | Only `a-zA-Z0-9._-/` (via `VALID_BRANCH_NAME_RE`) | Rules 4, 5, 10: no control chars, spaces, `~^:?*[\` |
| Leading/trailing slash | Cannot start or end with `/` | Rule 6: no leading/trailing `/` |
| Double dots | Cannot contain `..` | Rule 3: no `..` anywhere |
| `.lock` suffix | Cannot end with `.lock` | Rule 1: no component ending in `.lock` |
| Reflog syntax | Cannot contain `@{` | Rule 8: no `@{` |
| Empty path component | Cannot contain `//` | Rule 6: no consecutive slashes |

### Relationship to git-check-ref-format

The validation rules are a strict subset of
[git-check-ref-format](https://git-scm.com/docs/git-check-ref-format). The
full git specification includes ten rules; `isValidBranchName` enforces the
ones relevant to branch names used by Dispatch. The key differences:

| Git rule | Dispatch enforcement | Notes |
|----------|---------------------|-------|
| No `.` at start of path component | Not checked | Dispatch-generated names never start components with `.` |
| Must contain at least one `/` | Not enforced | Branch names like `main` are valid in Dispatch |
| Cannot end with `.` | Not checked | Covered indirectly by the character set and naming conventions |
| Cannot be `@` alone | Not checked | Dispatch never generates single-character `@` branch names |

The stricter character set (`VALID_BRANCH_NAME_RE`) rejects many characters
that git technically allows but that are problematic in shell contexts. For
example, git permits `@` in branch names, but Dispatch rejects it to avoid
ambiguity with reflog syntax.

## Security: command injection prevention

The `VALID_BRANCH_NAME_RE` regex `/^[a-zA-Z0-9._\-/]+$/` serves as a security
boundary. By restricting branch names to this character set, the validator
prevents injection of shell metacharacters that could be dangerous when branch
names are interpolated into `execFile` arguments:

| Rejected character | Injection risk |
|--------------------|---------------|
| `$` (dollar sign) | Shell variable expansion: `$(whoami)` |
| `` ` `` (backtick) | Command substitution: `` `rm -rf /` `` |
| `;` (semicolon) | Command chaining: `; malicious-command` |
| `\|` (pipe) | Pipeline injection |
| `>`, `<` | Redirection |
| `'`, `"` | Quote escaping |
| `\` (backslash) | Escape sequences |
| Space, tab, newline | Argument splitting |

The test at `src/tests/branch-validation.test.ts:63` explicitly verifies that
`$(whoami)` is rejected, confirming the security intent.

While Dispatch uses `execFile` (which passes arguments as an array without
shell interpolation), branch names may also flow to other tools or be displayed
in user-facing contexts. The strict allowlist provides defense-in-depth.

## The `InvalidBranchNameError` class

`InvalidBranchNameError` extends `Error` with a descriptive message format:

```
Invalid branch name: "<name>"
Invalid branch name: "<name>" (<reason>)
```

The optional `reason` parameter provides context about where the invalid name
came from (e.g., `"from symbolic-ref output"` when the default branch name
fails validation). The `name` property is set to `"InvalidBranchNameError"` for
reliable `instanceof` detection.

### How datasources use it

Both the [GitHub](../datasource-system/github-datasource.md) and [Azure DevOps](../datasource-system/azdevops-datasource.md) datasources validate branch names at two
points:

1. **Default branch detection** — after reading `git symbolic-ref`, the result
   is validated. If invalid, `InvalidBranchNameError` is thrown and caught to
   trigger the fallback chain (`main` → `master`).

2. **Branch name construction** — after `buildBranchName()` generates a
   `<username>/dispatch/<number>-<slug>` name, validation ensures the
   slugified title didn't produce an invalid result.

The GitHub datasource re-exports `InvalidBranchNameError` at
`src/datasources/github.ts:16` for external consumers.

## Branch naming conventions in Dispatch

Dispatch uses two distinct branch naming patterns:

### Per-issue branches

Generated by each datasource's `buildBranchName()` method:

```
<username>/dispatch/<issueNumber>-<slugified-title>
```

The title is slugified via [`slugify()`](../shared-utilities/slugify.md) and
truncated to 50 characters. These names always pass `isValidBranchName`
because `slugify()` produces only lowercase alphanumeric characters and
hyphens.

### Feature branches

Generated by `generateFeatureBranchName()` in `src/helpers/worktree.ts`:

```
dispatch/feature-<8-hex-chars>
```

The 8 hex characters are the first segment of a `crypto.randomUUID()` output,
providing 32 bits of entropy. These names always pass validation because they
contain only lowercase hex characters, hyphens, and slashes.

### Can users customize branch names?

No. Branch names are programmatically generated from issue metadata (number,
title, username) by each datasource implementation. There is no CLI flag or
configuration option to override the naming convention. The
`<username>/dispatch/<number>-<slug>` format is hardcoded in the datasource
modules.

## Cross-group consumers

| Consumer | Import | Usage |
|----------|--------|-------|
| GitHub datasource (`src/datasources/github.ts`) | `isValidBranchName`, `InvalidBranchNameError` | Default branch validation, branch name construction |
| Azure DevOps datasource (`src/datasources/azdevops.ts`) | `isValidBranchName`, `InvalidBranchNameError` | Default branch validation, branch name and username validation |
| Helpers barrel (`src/helpers/index.ts`) | Re-exports all | Available to any module via `helpers/` |

## Testing

The branch validation module has comprehensive test coverage in
`src/tests/branch-validation.test.ts` with 41 test cases organized into four
groups:

| Group | Tests | Coverage |
|-------|-------|----------|
| Valid branch names | 8 | Simple names, slashes, dots, underscores, max length |
| Empty and overlength | 2 | Empty string, 256 characters |
| Invalid characters | 11 | Spaces, colons, shell metacharacters, tildes, carets, backslashes, tabs, wildcards, brackets, newlines |
| Git refname structural rules | 8 | Leading/trailing slashes, `..`, `.lock`, `@{`, `//` |
| `InvalidBranchNameError` | 5 | `instanceof`, `name` property, message format with/without reason |
| `VALID_BRANCH_NAME_RE` | 3 | Valid characters, spaces, special characters |

To run just the branch validation tests:

```bash
npx vitest run tests/branch-validation.test.ts
```

## Related documentation

- [Overview](./overview.md) — Group-level summary
- [Authentication](./authentication.md) — OAuth authentication that runs
  before branch names are used in worktree operations
- [Worktree Management](./worktree-management.md) — `generateFeatureBranchName`
  which produces branch names that pass validation
- [Datasource Overview](../datasource-system/overview.md#branch-naming-convention) —
  The `<username>/dispatch/<number>-<slug>` convention
- [GitHub Datasource](../datasource-system/github-datasource.md) — Default
  branch detection fallback chain that uses `InvalidBranchNameError`
- [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) —
  Branch validation in work item lifecycle
- [Markdown Datasource](../datasource-system/markdown-datasource.md) —
  `buildBranchName()` implementation for local-first workflows
- [Shared Utilities — Slugify](../shared-utilities/slugify.md) — The slug
  algorithm that produces branch-safe strings
- [Integrations](./integrations.md) — Git CLI subprocess model and `execFile`
  security properties
- [Testing](./testing.md) — 41 branch validation tests plus auth and run-state
  tests
