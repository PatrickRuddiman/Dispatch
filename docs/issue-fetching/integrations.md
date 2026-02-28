# Integrations & Troubleshooting

This document covers the external tool integrations used by the issue fetching
subsystem: the GitHub CLI, Azure CLI, Git CLI, and Node.js `child_process`.
For each integration, it explains how the tool is invoked, what can go wrong,
and how to diagnose and resolve failures.

## Node.js child_process (execFile)

**Used in:** `src/issue-fetchers/github.ts:9`, `src/issue-fetchers/azdevops.ts:11`,
`src/issue-fetchers/index.ts:12`
**Official docs:**
[Node.js child_process.execFile](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)

All three external tools (`gh`, `az`, `git`) are invoked via
`util.promisify(execFile)`. Key characteristics:

- **No shell:** `execFile` spawns the binary directly, avoiding shell injection
  risks. Arguments are passed as an array, not interpolated into a command
  string.
- **Buffered output:** Both stdout and stderr are buffered in memory until the
  process exits. The default `maxBuffer` is 1,048,576 bytes (1 MB).
- **Promise-based:** The promisified wrapper returns
  `Promise<{ stdout: string, stderr: string }>`.

### What happens when a CLI tool is not installed

When `execFile` is called with a binary that does not exist on `PATH`, Node.js
throws an error with `code: 'ENOENT'` (Error NO ENTry -- file not found). The
behavior differs between the three call sites:

| Call site | Binary | Error handling | Result |
|-----------|--------|---------------|--------|
| `github.ts:21` | `gh` | No catch -- error propagates | Spec generator catches it, logs `Failed to fetch #<id>: spawn gh ENOENT`, marks issue as failed |
| `azdevops.ts:38` | `az` | No catch -- error propagates | Same as above: `Failed to fetch #<id>: spawn az ENOENT` |
| `azdevops.ts:91` | `az` (comments) | Caught by `fetchComments` try/catch | Silently returns empty comments array |
| `index.ts:68` | `git` | Caught by `detectIssueSource` try/catch | Returns `null`, triggering auto-detection failure message |

**The process does not crash.** All `ENOENT` errors are eventually caught --
either by the spec generator's per-issue try/catch
(`src/spec-generator.ts:114-118`) or by the function's own error handling.
The user sees a descriptive error message, and other issues in the batch
continue processing.

### Timeout behavior

**There is no timeout configured on any `execFile` call in the issue fetching
subsystem.** A hung `gh`, `az`, or `git` process will block the spec
generation pipeline indefinitely.

The `execFile` API supports a `timeout` option:

```typescript
await exec("gh", args, { cwd, timeout: 30000 }); // 30-second timeout
```

When the timeout fires, Node.js sends `SIGTERM` to the child process and
rejects the promise with an error that has `killed: true` and
`signal: 'SIGTERM'`.

This is a known gap. If subprocess hangs become a problem in practice, adding
a `timeout` option to the `exec` calls in both fetchers would be the
recommended fix. A reasonable default would be 30 seconds for issue fetches
and 15 seconds for comment fetches.

### Maximum buffer size

If a CLI tool produces more than 1 MB of output, `execFile` kills the child
process and rejects with `maxBuffer length exceeded`.

**In practice**, this is unlikely because:

- `gh issue view --json` returns a single issue's JSON -- typically a few KB.
- `az boards work-item show` returns one work item -- also a few KB.
- `az boards work-item relation list-comment` returns comments for one item.
- `git remote get-url origin` returns a single URL string.

If a work item with an extremely large description or many comments exceeds
1 MB, the `maxBuffer` option can be increased in the `exec` call.

## GitHub CLI (`gh`)

**Binary:** `gh`
**Used in:** `src/issue-fetchers/github.ts:21-31`
**Official docs:** [cli.github.com/manual](https://cli.github.com/manual/)

### Commands used

| Command | Purpose | Called from |
|---------|---------|------------|
| `gh issue view <id> --json number,title,body,labels,state,url,comments` | Fetch issue details | `src/issue-fetchers/github.ts:21-31` |

### How authentication works

The `gh` CLI manages its own credential store. It supports:

1. **Interactive login:** `gh auth login` -- browser-based OAuth or device code
2. **Environment variables:** `GH_TOKEN` or `GITHUB_TOKEN`
3. **Credential helpers:** Git credential manager integration

The dispatch code does **not** pass any authentication flags or tokens to `gh`.
It relies entirely on the user's pre-existing `gh` authentication state.

### Repository context

The `gh issue view` command requires repository context. It infers the target
repository from:

1. The git remote in the current working directory (passed as `{ cwd }`)
2. The `GH_REPO` environment variable (if set)
3. The `-R` / `--repo` flag (not used by the fetcher)

The fetcher passes `{ cwd: opts.cwd || process.cwd() }` to `execFile`,
ensuring `gh` can find the git remote.

### JSON output format

With `--json`, `gh` returns structured JSON instead of human-readable text.
The fetcher requests these fields: `number`, `title`, `body`, `labels`,
`state`, `url`, `comments`. The full list of available JSON fields for
`gh issue view` includes: `assignees`, `author`, `body`, `closed`,
`closedAt`, `comments`, `createdAt`, `id`, `isPinned`, `labels`, `milestone`,
`number`, `projectCards`, `projectItems`, `reactionGroups`, `state`,
`stateReason`, `title`, `updatedAt`, `url`.

See the full details in the
[GitHub Fetcher documentation](./github-fetcher.md).

## Azure CLI with azure-devops extension

**Binary:** `az`
**Used in:** `src/issue-fetchers/azdevops.ts:38`, `src/issue-fetchers/azdevops.ts:91`
**Official docs:**
[learn.microsoft.com/en-us/azure/devops/cli](https://learn.microsoft.com/en-us/azure/devops/cli/)

### Commands used

| Command | Purpose | Called from |
|---------|---------|------------|
| `az boards work-item show --id <id> --output json [--org <url>] [--project <name>]` | Fetch work item details | `src/issue-fetchers/azdevops.ts:21-40` |
| `az boards work-item relation list-comment --work-item-id <id> --output json [--org <url>] [--project <name>]` | Fetch work item comments | `src/issue-fetchers/azdevops.ts:73-93` |

### How authentication works

The `az` CLI manages credentials through Azure Active Directory:

1. **Interactive login:** `az login` -- browser-based
2. **PAT-based:** `az devops login --organization <url>` -- paste a Personal
   Access Token
3. **Service principal:** `az login --service-principal` -- for CI/CD

The dispatch code does **not** pass credentials to `az`. It relies on the
user's pre-existing Azure CLI authentication state.

### Organization and project resolution

The `az boards` commands require an organization and project context. The
Azure CLI resolves these in order:

1. **Explicit flags:** `--org` and `--project` on the command line (highest
   priority)
2. **Configured defaults:** Set via `az devops configure --defaults`
3. **Git config auto-detection:** The `az` CLI can detect org/project from
   the git remote (requires `--detect true`, which is not passed by the
   fetcher)

The fetcher conditionally passes `--org` and `--project` only when provided
in `IssueFetchOptions` (`src/issue-fetchers/azdevops.ts:31-36`). If neither
is provided and no defaults are configured, the `az` command fails.

### The `list-comment` command

The `az boards work-item relation list-comment` command is part of the
`azure-devops` extension. It may not be available in all extension versions.
If the command is not recognized, the catch block in `fetchComments()`
returns an empty array without propagating the error.

See the
[Azure DevOps Fetcher documentation](./azdevops-fetcher.md) for full details.

## Git CLI

**Binary:** `git`
**Used in:** `src/issue-fetchers/index.ts:68-71`
**Official docs:**
[git-scm.com/docs/git-remote](https://git-scm.com/docs/git-remote)

### Command used

| Command | Purpose | Called from |
|---------|---------|------------|
| `git remote get-url origin` | Get the origin remote URL for auto-detection | `src/issue-fetchers/index.ts:68-71` |

### How it works

`detectIssueSource()` runs `git remote get-url origin` in the specified `cwd`.
The command:

1. Returns the URL configured for the `origin` remote.
2. Outputs a single line (the URL) to stdout.
3. Exits with code 0 on success.

### Failure modes

| Cause | git exit code | Error message | Handling |
|-------|--------------|---------------|----------|
| Not a git repository | Non-zero | `fatal: not a git repository` | Caught, returns `null` |
| No `origin` remote | Non-zero | `fatal: No such remote 'origin'` | Caught, returns `null` |
| Remote has no URL | Non-zero | `fatal: No URL configured for remote 'origin'` | Caught, returns `null` |

All failures are caught by the `try/catch` in `detectIssueSource()`
(`src/issue-fetchers/index.ts:82-84`). The function returns `null`, and the
spec generator prompts the user to specify `--source` explicitly.

### SSH vs HTTPS URLs

Both SSH and HTTPS remote URL formats are handled correctly because the
auto-detection patterns match against the hostname string, which appears in
both formats:

- HTTPS: `https://github.com/owner/repo` -- contains `github.com`
- SSH: `git@github.com:owner/repo.git` -- contains `github.com`
- HTTPS: `https://dev.azure.com/org/project` -- contains `dev.azure.com`
- SSH: `git@ssh.dev.azure.com:v3/org/project/repo` -- contains `dev.azure.com`
- HTTPS: `https://org.visualstudio.com/project` -- contains `visualstudio.com`

## Error handling patterns

The issue fetching subsystem uses two distinct error handling strategies:

### Strategy 1: Propagate (main fetch)

The main `fetch()` method in both fetchers lets errors propagate. The spec
generator catches them at `src/spec-generator.ts:114-118`:

```
try {
  const details = await fetcher.fetch(id, fetchOpts);
  // success
} catch (err) {
  log.error(`Failed to fetch #${id}: ${message}`);
  // issue marked as failed, processing continues
}
```

This means:
- A failed fetch for one issue does not stop other issues from being fetched.
- The error message (including stderr from the CLI tool) is logged.
- The final summary reports how many issues failed.

### Strategy 2: Swallow (comment fetch)

The `fetchComments()` function in the Azure DevOps fetcher catches all errors
and returns an empty array (`src/issue-fetchers/azdevops.ts:105-106`). This
means:
- Comment fetch failures are completely silent.
- The work item is still returned with all other fields populated.
- There is no way to distinguish "no comments exist" from "comment fetch
  failed" in the returned data.

## Related documentation

- [Overview](./overview.md) -- Architecture and data flow diagrams
- [GitHub Fetcher](./github-fetcher.md) -- GitHub-specific setup and
  troubleshooting
- [Azure DevOps Fetcher](./azdevops-fetcher.md) -- Azure DevOps-specific
  setup and troubleshooting
- [Adding a Fetcher](./adding-a-fetcher.md) -- Implementing new integrations
- [Planning & Dispatch Integrations](../planning-and-dispatch/integrations.md) --
  Git CLI and Node.js child_process usage in the dispatch pipeline
