# GitHub Datasource Tests

Tests for the GitHub datasource implementation (`src/datasources/github.ts`), covering Octokit-based issue and pull request operations, label filtering, commit message extraction, branch lifecycle management, and credential redaction.

**Test file:** `src/tests/github-datasource.test.ts` (593 lines, 11 describe blocks)

## What is tested

The GitHub datasource communicates with GitHub through the Octokit REST API client. It translates the generic `Datasource` interface into GitHub Issues and Pull Requests API calls. The test suite validates every public method plus the exported `getCommitMessages` helper.

## How authentication works in tests

Authentication is fully mocked. The test file replaces `getGithubOctokit` from `src/helpers/auth.js` with a stub that returns a mock Octokit instance. This mock provides:

- `rest.issues.listForRepo`, `rest.issues.get`, `rest.issues.listComments`, `rest.issues.update`, `rest.issues.create`
- `rest.pulls.create`, `rest.pulls.list`
- `paginate` -- used for paginated list endpoints

The real auth module uses GitHub's OAuth device-code flow via `@octokit/auth-oauth-device`. The user is prompted with a verification URL and code; the resulting token is cached at `~/.dispatch/auth.json`.

See: `src/helpers/auth.ts:81-109`

## Issue operations

### list

Uses `octokit.paginate` to fetch all open issues. Filters out pull requests by checking for the `pull_request` property on each result. Extracts labels as string names, filtering out empty and null label names.

See: `src/tests/github-datasource.test.ts:53-97`

### fetch

Calls `octokit.rest.issues.get` for the issue details, then `octokit.paginate` for comments. Comments are formatted as `**{login}:** {body}`. Handles null comment bodies by producing `**{login}:** ` (no "null" string). Filters empty/null label names.

See: `src/tests/github-datasource.test.ts:99-160`

### update

Calls `octokit.rest.issues.update` with `{ owner, repo, issue_number, title, body }`.

See: `src/tests/github-datasource.test.ts:162-176`

### close

Calls `octokit.rest.issues.update` with `{ owner, repo, issue_number, state: "closed" }`.

See: `src/tests/github-datasource.test.ts:178-191`

### create

Calls `octokit.rest.issues.create` and returns `IssueDetails`. Filters empty/null label names from the response.

See: `src/tests/github-datasource.test.ts:193-228`

## Default branch detection

Same strategy as Azure DevOps: `git symbolic-ref refs/remotes/origin/HEAD`, falling back to "main" then "master". Branch name validation rejects spaces, shell metacharacters, names exceeding 255 characters, and empty names.

See: `src/tests/github-datasource.test.ts:230-288`

## Branch naming and lifecycle

### buildBranchName

Produces `{username}/dispatch/issue-{number}`. Falls back to `unknown/dispatch/issue-{number}` when username is omitted.

See: `src/tests/github-datasource.test.ts:290-300`

### createAndSwitchBranch

Same three-step recovery as the Azure DevOps datasource:
1. `git checkout -b {branch}`
2. On "already exists" error: `git checkout {branch}`
3. On worktree lock: `git worktree prune` then retry checkout

See: `src/tests/github-datasource.test.ts:302-372`

### Other git operations

- **switchBranch:** `git checkout {branch}`
- **pushBranch:** `git push --set-upstream origin {branch}`
- **commitAllChanges:** `git add -A`, check `git diff --cached --stat`, commit only if diff output is non-empty

See: `src/tests/github-datasource.test.ts:374-424`

## Pull request creation

### Standard flow

Creates PR via `octokit.rest.pulls.create` with `{ owner, repo, head: branchName, base: defaultBranch, title, body }`. Returns `html_url` from the response.

### Empty body default

When the body parameter is an empty string, the datasource uses `"Closes #{issueNumber}"` as the default PR description.

### Rich body pass-through

When a non-empty body is provided (including multiline markdown with Summary sections, task lists, and close references), it is passed through to `pulls.create` unchanged.

### PR recovery

When `pulls.create` throws a `RequestError` with status 422 (validation failed, indicating the PR already exists), the datasource queries `pulls.list` with the source branch as `head` and returns the first existing PR's URL. Non-422 errors (e.g., auth failures) are re-thrown.

The tests use a real `@octokit/request-error` `RequestError` instance (not mocked) to ensure the `instanceof` check in the datasource works correctly.

See: `src/tests/github-datasource.test.ts:426-529`

### PR body differences: GitHub vs. Azure DevOps

| Feature | GitHub | Azure DevOps |
|---------|--------|--------------|
| Close reference | `Closes #42` | `Resolves AB#42` |
| Default empty body | `Closes #42` | `Resolves AB#42` |
| Work item linking | Via close reference in body | Via `workItemRefs` array in API |
| PR recovery trigger | `RequestError` with status 422 | Error message containing "already exists" |

## Username derivation

Same algorithm as Azure DevOps but with slightly different truncation:

1. Use `opts.username` if provided
2. Multi-word name: first 2 chars of first name + last name, lowercased (e.g., "Patrick Ruddiman" -> "paruddim")
3. Single-word name: fall back to email local part (e.g., "patrick@example.com" -> "patrick")
4. All failures: return "unknown"

See: `src/tests/github-datasource.test.ts:532-558`

## getCommitMessages helper

Exported helper that runs `git log {base}..HEAD --pretty=format:%s` and returns an array of commit message strings. Returns empty array on failure.

See: `src/tests/github-datasource.test.ts:560-576`

## Credential redaction in error messages

When `getGitRemoteUrl` returns a URL with embedded credentials and `parseGitHubRemoteUrl` returns null (non-GitHub host), the error message replaces credentials with `***@`.

See: `src/tests/github-datasource.test.ts:578-593`

## Related documentation

- [Datasource test suite overview](./datasource-tests.md)
- [Azure DevOps datasource tests](./azdevops-datasource-tests.md)
- [Markdown datasource tests](./md-datasource-tests.md)
- [Datasource system architecture](../datasource-system/)
- [URL parsing tests](./datasource-url-parsing-tests.md)
- [Auth Tests](./auth-tests.md) -- authentication tests covering
  `getGithubOctokit()` used by the GitHub datasource
- [Datasource System Overview](../datasource-system/overview.md) -- how the
  GitHub datasource fits into the broader datasource architecture
- [GitHub Fetcher](../issue-fetching/github-fetcher.md) -- issue fetching
  logic exercised by the GitHub datasource
