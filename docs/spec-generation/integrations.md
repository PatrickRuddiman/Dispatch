# Integrations & Troubleshooting

This page documents the external dependencies and integrations used by the
spec generation pipeline, answering operational questions about configuration,
behavior, and troubleshooting.

## Git CLI (auto-detection)

**Used in:** `src/issue-fetchers/index.ts:64-84`
**Official docs:** [git-scm.com/docs/git-remote](https://git-scm.com/docs/git-remote)

The spec generator uses `git remote get-url origin` to auto-detect the issue
source when `--source` is not provided. This is the same auto-detection
mechanism used by the [datasource system](../datasource-system/overview.md#auto-detection).

### How auto-detection works

The `detectIssueSource()` function in `src/issue-fetchers/index.ts`:

1. Spawns `git remote get-url origin` via `execFile` (no shell).
2. Trims the output and tests it against patterns in order.
3. Returns the first matching `IssueSourceName`, or `null` if no match.

The `get-url` subcommand returns the configured URL for a remote, expanding
any `insteadOf` rewrite rules configured in git config. On success, the exit
status is `0`. If the remote does not exist, the exit status is `2`.

### What happens if the directory is not a git repository

If the working directory is not a git repository or has no `origin` remote,
`git remote get-url origin` exits with a non-zero status (typically `128` for
"not a git repository" or `2` for "no such remote"). The `catch` block in
`detectIssueSource()` returns `null`, and the spec generator displays:

```
Could not detect issue source from the repository remote URL.
  Supported sources: github, azdevops
  Use --source <name> to specify explicitly, or ensure the git remote
  points to a supported platform (github.com, dev.azure.com).
```

All issues are marked as failed and the process exits with code `1`.

### SSH vs HTTPS URL support

Both URL formats are supported because the detection patterns test for the
hostname string anywhere in the URL:

| URL format | Example | Matches |
|------------|---------|---------|
| HTTPS | `https://github.com/owner/repo` | `/github\.com/i` |
| SSH | `git@github.com:owner/repo.git` | `/github\.com/i` |
| HTTPS (Azure) | `https://dev.azure.com/org/project` | `/dev\.azure\.com/i` |
| SSH (Azure) | `git@ssh.dev.azure.com:v3/org/project/repo` | `/dev\.azure\.com/i` |
| Legacy Azure | `https://org.visualstudio.com/project` | `/visualstudio\.com/i` |

### Troubleshooting auto-detection failures

| Symptom | Cause | Resolution |
|---------|-------|------------|
| "Could not detect issue source" | Remote URL does not contain `github.com`, `dev.azure.com`, or `visualstudio.com` | Use `--source github` or `--source azdevops` explicitly |
| "Could not detect issue source" | No `origin` remote configured | Run `git remote add origin <url>` or use `--source` |
| "Could not detect issue source" | Not a git repository | Initialize with `git init` or use `--source` |
| GitHub Enterprise URL not detected | Pattern only matches `github.com`, not `github.mycompany.com` | Use `--source github` |
| Multiple remotes, wrong one detected | Only `origin` is inspected | Ensure `origin` points to the correct platform, or use `--source` |

### Verifying the git remote URL

To check what URL auto-detection will see:

```bash
git remote get-url origin
```

If this outputs nothing or errors, auto-detection will fail.

---

## AI Provider Backend (OpenCode / Copilot)

**Used in:** `src/spec-generator.ts:25`, `src/spec-generator.ts:129`,
`src/spec-generator.ts:197-200`
**See also:** [Provider Abstraction](../provider-system/provider-overview.md),
[OpenCode Backend](../provider-system/opencode-backend.md),
[Copilot Backend](../provider-system/copilot-backend.md)

The spec generator uses the same [`ProviderInstance`](../provider-system/provider-overview.md#the-providerinstance-interface) interface as the dispatch
pipeline. It boots a provider, creates one session per issue, sends the spec
prompt, and calls cleanup when done.

### Starting and connecting to a provider

**Automatic mode (default):**

```bash
# OpenCode (default) — SDK starts its own server
dispatch --spec 42,43

# Copilot — SDK discovers Copilot CLI
dispatch --spec 42,43 --provider copilot
```

**External server mode (`--server-url`):**

```bash
# Connect to a running OpenCode server
dispatch --spec 42,43 --server-url http://localhost:4096

# Connect to a running Copilot CLI server
dispatch --spec 42,43 --provider copilot --server-url http://localhost:3000
```

When `--server-url` is provided, the provider connects to an already-running
server instead of spawning one. This is useful for:

- Reusing a single server across multiple `--spec` invocations
- Connecting to a remote AI server
- Development and debugging of provider interactions

### Authentication requirements

**OpenCode:** Authentication is managed by the OpenCode server. When using
automatic mode, the OpenCode SDK handles server lifecycle and authentication
internally. When using `--server-url`, the external server must be
authenticated independently. Dispatch does not pass credentials.

**Copilot:** Supports four authentication methods with a defined precedence:

1. Logged-in Copilot CLI user (via `copilot auth`)
2. `COPILOT_GITHUB_TOKEN` environment variable
3. `GH_TOKEN` environment variable
4. `GITHUB_TOKEN` environment variable

See the [Copilot Backend documentation](../provider-system/copilot-backend.md)
for full authentication setup.

### Troubleshooting provider failures

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| "Failed to create OpenCode session" | Server not running or unreachable | Verify `--server-url`; check server is running |
| Boot timeout | Server startup taking too long | Check for port conflicts; increase system resources |
| "AI returned an empty spec" | Model failed to produce output | Retry; check provider logs for errors |
| Provider connection refused | External server not running at specified URL | Start the server first, then re-run |
| Orphaned server process after error | `cleanup()` not called on unhandled errors | Manually kill the provider process |

### Token/context limits and large prompts

The spec prompt includes:

- Issue title, description, labels, state, URL
- Acceptance criteria (if present)
- Discussion comments (all of them)
- Detailed instructions and output format template

For issues with long descriptions or many comments, the prompt can be large.
There is **no size validation or truncation** before sending to the provider.

If the prompt exceeds the provider's context window:

- The provider may truncate the input (model-dependent behavior)
- The provider may return an error
- The provider may produce degraded output

**Mitigation:** If you have issues with very long descriptions, consider
summarizing the issue content before running `--spec`, or split large issues
into smaller ones.

---

## GitHub Issues (via fetcher)

The spec generator fetches GitHub issues via the `gh` CLI tool to populate
the AI prompt with issue details (title, description, labels, comments).

For full documentation on `gh` CLI setup, authentication, commands,
troubleshooting, and rate limits, see the
[GitHub Fetcher](../issue-fetching/github-fetcher.md) and
[Datasource Integrations](../datasource-system/integrations.md) pages.

---

## Azure DevOps Work Items (via fetcher)

The spec generator fetches Azure DevOps work items via the `az` CLI with the
`azure-devops` extension to populate the AI prompt with work item details.

For full documentation on `az` CLI setup, authentication, commands,
`--org`/`--project` resolution, troubleshooting, and comment fetching
behavior, see the
[Azure DevOps Fetcher](../issue-fetching/azdevops-fetcher.md) and
[Datasource Integrations](../datasource-system/integrations.md) pages.

---

## Node.js File System (spec output)

**Used in:** `src/spec-generator.ts:19`, `src/spec-generator.ts:132`,
`src/spec-generator.ts:153`
**Official docs:** [Node.js fs.promises](https://nodejs.org/api/fs.html)

The spec generator uses `fs/promises` for two operations:

1. **`mkdir(outputDir, { recursive: true })`** -- creates the output directory
   and any parent directories that do not exist.
2. **`writeFile(filepath, spec, "utf-8")`** -- writes each spec file.

### Permissions

- The process must have write permission on the parent directory of `outputDir`
  (or `outputDir` itself if it already exists).
- On most systems, the default `.dispatch/specs/` location inherits the
  project directory's permissions.
- If the output directory is outside the project (e.g., `/tmp/specs`), ensure
  the user has write access.

### Changing the output location

Use `--output-dir` to specify an alternative output directory (see
[CLI Options](../cli-orchestration/cli.md#options-reference)):

```bash
dispatch --spec 42,43 --output-dir /path/to/specs
```

The value is resolved to an absolute path by the CLI (`src/cli.ts:127`).

### File encoding

All spec files are written with UTF-8 encoding. The AI provider's response is
written as-is without any encoding conversion or BOM handling.

---

## Chalk (CLI output formatting)

**Used in:** `src/logger.ts`
**Official docs:** [github.com/chalk/chalk](https://github.com/chalk/chalk)

Chalk is used by the logger for colored terminal output during spec generation.
It provides `log.info()`, `log.success()`, `log.error()`, and `log.dim()`
formatting.

### Non-TTY environments (CI pipelines)

Chalk v5 automatically detects whether stdout is a TTY:

- **TTY (interactive terminal):** Colors are applied.
- **Non-TTY (piped output, CI):** Colors are stripped automatically.

### Forcing or disabling color

| Environment variable | Effect |
|---------------------|--------|
| `FORCE_COLOR=1` | Force colors even in non-TTY |
| `FORCE_COLOR=0` or `NO_COLOR=1` | Disable colors entirely |

### Machine-readable log parsing

The spec generator's log output is not structured (no JSON format). To parse
logs programmatically, disable colors with `NO_COLOR=1` and parse the
plain-text output. The log format is:

```
ℹ Detecting issue source from git remote...
ℹ Detected issue source: github
ℹ Fetching 2 issue(s) from github...
✔ Fetched #42: Add user authentication
✖ Failed to fetch #99: Not Found
ℹ Booting opencode provider...
ℹ Generating spec for #42: Add user authentication...
✔ Spec written: /path/.dispatch/specs/42-add-user-authentication.md
ℹ Spec generation complete: 1 generated, 1 failed
```

See the [Chalk reference](../shared-types/integrations.md#chalk) for full
documentation on chalk color detection and level overrides.

## Related documentation

- [Spec Generation Overview](./overview.md) -- Pipeline architecture, AI
  prompt, and output format
- [Issue Fetching](../issue-fetching/overview.md) -- Fetcher architecture and
  data normalization
- [GitHub Fetcher](../issue-fetching/github-fetcher.md) -- GitHub CLI
  integration details
- [Azure DevOps Fetcher](../issue-fetching/azdevops-fetcher.md) -- Azure
  DevOps fetcher shim (delegates to datasource layer)
- [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) --
  Azure CLI integration details
- [Datasource Overview](../datasource-system/overview.md) -- Datasource
  abstraction, auto-detection, and `IssueDetails` interface
- [Provider Abstraction](../provider-system/provider-overview.md) -- Provider
  lifecycle and backend implementations
- [CLI Argument Parser](../cli-orchestration/cli.md) -- `--spec` mode flags
  and exit codes
- [Configuration](../cli-orchestration/configuration.md) -- Persistent config
  for `source`, `provider`, and other settings
- [Datasource Helpers](../datasource-system/datasource-helpers.md) -- Temp
  file writing and issue ID extraction used alongside spec generation
- [Shared Utilities — Slugify](../shared-utilities/slugify.md) -- Slug
  generation used for spec output filenames
- [Logger](../shared-types/logger.md) -- Structured logging facade used for
  spec generation progress and error reporting
- [Spec Generator Tests](../testing/spec-generator-tests.md) -- Test suite
  covering spec generation utility functions
