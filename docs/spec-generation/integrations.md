# Integrations & Troubleshooting

This page documents the external dependencies and integrations used by the
spec generation pipeline, answering operational questions about configuration,
behavior, and troubleshooting.

## Git CLI (auto-detection)

**Used in:** `src/spec-generator.ts` (`resolveSource()` → datasource
auto-detection)
**Official docs:** [git-scm.com/docs/git-remote](https://git-scm.com/docs/git-remote)

The spec pipeline uses `git remote get-url origin` to auto-detect the issue
source when `--source` is not provided. This occurs inside `resolveSource()`
which delegates to the [datasource system](../datasource-system/overview.md#auto-detection)
for git-based detection.

### How auto-detection works

The `resolveSource()` function in `src/spec-generator.ts` follows a priority
chain:

1. **Explicit `--source`** — used directly if provided.
2. **Git auto-detect** — spawns `git remote get-url origin` and matches
   against known hostname patterns.
3. **Fallback for non-issue inputs** — returns `"md"` for file/glob and
   inline text inputs (no tracker needed).
4. **Null for issue inputs** — returns `null` if auto-detection fails,
   causing the pipeline to abort.

The `get-url` subcommand returns the configured URL for a remote, expanding
any `insteadOf` rewrite rules configured in git config. On success, the exit
status is `0`. If the remote does not exist, the exit status is `2`.

### What happens if the directory is not a git repository

If the working directory is not a git repository or has no `origin` remote,
`git remote get-url origin` exits with a non-zero status (typically `128` for
"not a git repository" or `2` for "no such remote"). The detection returns
`null`. For tracker-mode inputs, this causes the pipeline to abort with an
error. For file/glob and inline text inputs, the fallback to `"md"` datasource
means git is not required.

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
| Source detection fails | Remote URL does not match known patterns | Use `--source github` or `--source azdevops` explicitly |
| Source detection fails | No `origin` remote configured | Run `git remote add origin <url>` or use `--source` |
| Source detection fails | Not a git repository | Initialize with `git init` or use `--source` |
| GitHub Enterprise URL not detected | Pattern only matches `github.com` | Use `--source github` |
| Multiple remotes, wrong one detected | Only `origin` is inspected | Ensure `origin` points to the correct platform, or use `--source` |

### Verifying the git remote URL

To check what URL auto-detection will see:

```bash
git remote get-url origin
```

If this outputs nothing or errors, auto-detection will fail for tracker mode.
File/glob and inline text modes will still work (they fall back to `"md"`
datasource).

---

## AI Provider Backend (OpenCode / Copilot)

**Used in:** `src/orchestrator/spec-pipeline.ts` (provider boot at line 208),
`src/agents/spec.ts` (session creation, prompting)
**See also:** [Provider Abstraction](../provider-system/overview.md),
[OpenCode Backend](../provider-system/opencode-backend.md),
[Copilot Backend](../provider-system/copilot-backend.md)

The spec pipeline boots a provider via `bootProvider()` in the orchestrator,
then passes the `ProviderInstance` to `boot()` in the spec agent. The agent
creates one session per spec item and sends the constructed prompt.

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

### Provider cleanup

The pipeline registers provider cleanup via `registerCleanup()` at line 209
of `src/orchestrator/spec-pipeline.ts`. At the end of processing, cleanup
occurs in two stages:

1. `specAgent.cleanup()` — removes `.dispatch/tmp/` directory.
2. `instance.cleanup()` — shuts down the provider server.

Both are wrapped in try/catch — failures are logged but do not throw. The
[cleanup registry](../shared-types/cleanup.md) provides a safety net for
unhandled errors.

### Troubleshooting provider failures

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| "Failed to create session" | Server not running or unreachable | Verify `--server-url`; check server is running |
| Boot timeout | Server startup taking too long | Check for port conflicts; increase system resources |
| AI did not write temp file | Model misunderstood instructions | Check error message (includes first 300 chars of response); retry |
| Provider connection refused | External server not running at specified URL | Start the server first, then re-run |
| Orphaned server process | Error before cleanup ran | Manually kill the provider process; cleanup registry should handle most cases |
| Null response from `prompt()` | Provider returned empty/null | Spec marked as failed; retried up to `--retries` times |
| `Timed out after ... [specAgent.generate(...)]` | The overall generation attempt exceeded `--spec-timeout` | Increase `--spec-timeout`, reduce prompt scope, or retry the item |

### What happens if the provider dies mid-prompt

If the AI provider server crashes or becomes unreachable while the spec agent
is waiting for a response (`provider.prompt(sessionId, specPrompt)`), the
behavior depends on the provider backend:

- **OpenCode:** If the SSE event stream disconnects, the follow-up
  `session.messages()` fetch fails and `prompt()` rejects with a connection
  error. If the stream stays open but silent, the provider itself has no idle
  timeout; in spec-generation runs the outer `--spec-timeout` deadline still
  bounds the whole attempt.
- **Copilot:** The event listener promise rejects (either from a `session.error`
  event or the 600-second timeout). Same catch behavior applies.

In both cases:

1. The failed spec is retried up to `--retries` times (default 2) via
   `withRetry()`.
2. If all retries fail, the item is counted as `failed` in the summary.
3. Other items in the batch continue processing independently — a provider
   failure for one spec does **not** abort the entire batch.
4. The provider's cleanup function (registered via `registerCleanup()`) runs
   at pipeline end or on signal exit.

**No automatic provider restart:** If the provider server crashes permanently,
all subsequent specs in the batch will also fail. The pipeline does not attempt
to reboot the provider mid-run. Manual intervention (restarting the server,
or re-running the command) is required.

**Timeout layering:** Unlike the hardcoded 30-second fetch timeout, provider
prompt handling is split across layers. Copilot has a provider-local idle
timeout, OpenCode surfaces stream errors/disconnects, and the spec pipeline also
wraps each `specAgent.generate(...)` attempt in the user-configurable
`--spec-timeout` deadline. If that deadline fires, the item is retried up to
`--retries` times and then counted as failed without aborting healthy items in
the same batch. See
[Provider Timeouts](../provider-system/overview.md#prompt-timeouts-and-cancellation)
for details.

### Token/context limits and large prompts

The spec prompt includes the full issue description, acceptance criteria,
discussion comments, and detailed instructions. There is **no size validation
or truncation** before sending to the provider.

If the prompt exceeds the provider's context window:

- The provider may truncate the input (model-dependent behavior)
- The provider may return an error
- The provider may produce degraded output

**Mitigation:** For issues with very long descriptions, consider summarizing
the issue content before running `--spec`, or split large issues into smaller
ones.

---

## Datasource System

**Used in:** `src/orchestrator/spec-pipeline.ts` (issue fetching,
datasource sync)
**See also:** [Datasource Overview](../datasource-system/overview.md),
[Datasource Integrations](../datasource-system/integrations.md)

The spec pipeline uses the datasource system in two places:

### Issue fetching (tracker mode)

In tracker mode, the pipeline fetches issue details through the datasource
layer. Issues are fetched concurrently in batches. The fetched `IssueDetails`
objects include: title, description, labels, state, URL, acceptance criteria,
and discussion comments.

### Datasource sync (post-generation)

After specs are generated, the pipeline syncs results back to the datasource:

| Mode | Datasource | Behavior |
|------|-----------|----------|
| Tracker | Non-md (GitHub, AzDevOps) | Updates existing issues, deletes local spec files |
| Tracker | Md | Keeps local files in-place |
| File | Non-md (GitHub, AzDevOps) | Creates new tracker issues, deletes local spec files |
| File | Md | Keeps files in-place |
| Inline text | Any | No sync (inline text has no tracker origin) |

### Troubleshooting datasource issues

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| "Could not detect datasource" | No git remote or unrecognized URL | Use `--source` flag explicitly |
| Issue fetch returns empty content | Azure DevOps HTML content parsing issue | Check `az boards work-item show` output manually |
| Sync fails silently | Datasource API error caught by pipeline | Check pipeline log output for warnings |

---

## glob (file/glob mode)

**Used in:** `src/orchestrator/spec-pipeline.ts` (glob resolution for
file/glob input mode)
**Official docs:** [github.com/isaacs/node-glob](https://github.com/isaacs/node-glob)

The `glob` package resolves file patterns in file/glob input mode. It is
called with `{ cwd, absolute: true }` to produce absolute file paths.

### How it is used

When `isGlobOrFilePath()` classifies input as file/glob mode, the pipeline
passes the input pattern to `glob()`:

```
glob(pattern, { cwd, absolute: true })
```

This resolves patterns like `"docs/requirements/*.md"` or
`"specs/**/*.txt"` against the working directory.

### Pattern syntax

Standard glob patterns are supported:

| Pattern | Matches |
|---------|---------|
| `*.md` | All `.md` files in cwd |
| `docs/**/*.md` | All `.md` files recursively under `docs/` |
| `{specs,reqs}/*.md` | `.md` files in either `specs/` or `reqs/` |
| `file?.txt` | `file1.txt`, `fileA.txt`, etc. |

### Troubleshooting glob issues

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| No files matched | Pattern does not match any files | Verify pattern with `ls` or `find`; check `--cwd` |
| Input classified as inline text | Pattern doesn't contain glob metacharacters or path separators | Add `./` prefix or use full path |
| Too many files matched | Overly broad pattern | Use more specific patterns; the large batch confirmation will trigger at 100+ items |

---

## @inquirer/prompts (large batch confirmation)

**Used in:** `src/helpers/confirm-large-batch.ts`
**Official docs:** [github.com/SBoudrias/Inquirer.js](https://github.com/SBoudrias/Inquirer.js)

The `@inquirer/prompts` package provides the `input()` function used for
the large batch confirmation prompt. When processing more than 100 items,
the user must type `"yes"` to continue.

### Behavior in non-interactive environments

The `input()` function from `@inquirer/prompts` requires an interactive
terminal (TTY). In CI pipelines or non-interactive shells:

- The prompt will hang waiting for input, or throw an error depending on
  the environment.
- **Workaround:** Keep batch sizes at or below 100 items, or pipe `"yes"`
  to stdin.

### Configuration

The threshold is hardcoded at `LARGE_BATCH_THRESHOLD = 100` in
`src/helpers/confirm-large-batch.ts`. There is no CLI flag or configuration
option to change it.

---

## Node.js File System (spec output)

**Used in:** `src/agents/spec.ts` (temp file operations, final file write),
`src/orchestrator/spec-pipeline.ts` (output directory creation, file rename)
**Official docs:** [Node.js fs.promises](https://nodejs.org/api/fs.html)

The pipeline uses `fs/promises` for several operations:

### Operations

| Operation | Location | Purpose |
|-----------|----------|---------|
| `mkdir(dir, { recursive: true })` | spec-pipeline.ts | Create output directory |
| `mkdir(tmpDir, { recursive: true })` | agents/spec.ts | Create `.dispatch/tmp/` |
| `readFile(tempPath, "utf-8")` | agents/spec.ts | Read AI-written temp file |
| `writeFile(path, content, "utf-8")` | agents/spec.ts | Write final spec file |
| `rm(tempPath)` | agents/spec.ts | Delete temp file |
| `rename(oldPath, newPath)` | spec-pipeline.ts | Rename file based on H1 title |
| `rm(tmpDir, { recursive: true })` | agents/spec.ts cleanup | Remove temp directory |

### Permissions

- The process must have write permission on the parent directory of the output
  directory (or the directory itself if it already exists).
- On most systems, the default `.dispatch/specs/` location inherits the
  project directory's permissions.
- The `.dispatch/tmp/` directory requires write permission within the project.

### File encoding

All spec files are written with UTF-8 encoding. The AI provider's response is
processed through `extractSpecContent()` before writing — no raw AI output
reaches the final file without post-processing.

### Changing the output location

Use `--output-dir` to specify an alternative output directory (see
[CLI Options](../cli-orchestration/cli.md#options-reference)):

```bash
dispatch --spec 42,43 --output-dir /path/to/specs
```

---

## Chalk (CLI output formatting)

**Used in:** `src/logger.ts` (shared logger used by all spec pipeline files)
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

The spec pipeline's log output is not structured (no JSON format). To parse
logs programmatically, disable colors with `NO_COLOR=1` and parse the
plain-text output. The log format includes:

```
ℹ Detecting source...
ℹ Detected source: github
ℹ Fetching 2 issue(s)...
✔ Fetched #42: Add user authentication
✖ Failed to fetch #99: Not Found
ℹ Booting opencode provider...
ℹ Generating spec for #42: Add user authentication...
✔ Spec written: .dispatch/specs/42-add-user-authentication.md
ℹ Spec generation complete: 1 generated, 1 failed
```

See the [Chalk reference](../shared-types/integrations.md#chalk) for full
documentation on chalk color detection and level overrides.

## FileLogger and AsyncLocalStorage (per-issue logging)

**Used in:** `src/orchestrator/spec-pipeline.ts` (scoped per-item logging),
`src/agents/spec.ts` (prompt/response/event logging within agent)
**Official docs:** [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)

The spec pipeline uses Node.js `AsyncLocalStorage` to scope a `FileLogger`
instance to each spec generation item, providing per-issue structured logs
that are invaluable for debugging failures in batch runs.

### How it works

When `--verbose` is enabled, the pipeline creates a `FileLogger` instance per
item and wraps the generation call in `fileLoggerStorage.run()`:

1. **Pipeline creates logger:** `new FileLogger(id, specCwd)` — where `id` is
   the issue number or file identifier and `specCwd` is the working directory.
2. **AsyncLocalStorage scopes it:** `fileLoggerStorage.run(fileLogger, () => ...)`
   makes the logger available to all async code within the callback.
3. **Agent accesses it:** `fileLoggerStorage.getStore()?.prompt(...)`,
   `fileLoggerStorage.getStore()?.response(...)`, etc.

### What gets logged

| Method | Called by | Content |
|--------|----------|---------|
| `prompt("spec", prompt)` | Spec agent | Full AI prompt text (before sending) |
| `response("spec", response)` | Spec agent | Full AI response text |
| `agentEvent("spec", "completed", duration)` | Spec agent | Completion event with elapsed time |
| `error(message)` | Spec agent, pipeline | Error details with stack traces |
| `info(message)` | Pipeline | Output path, generation start, success messages |
| `phase("Datasource sync")` | Pipeline | Phase transition markers |

### Log file location and naming

Log files are written to `.dispatch/logs/` within the project directory:

```
.dispatch/logs/issue-{sanitizedId}.log
```

The issue ID is sanitized by removing all characters except alphanumerics,
`.`, `_`, and `-`. Examples:

| Item ID | Log file |
|---------|----------|
| `42` | `.dispatch/logs/issue-42.log` |
| `my-feature.md` | `.dispatch/logs/issue-my-feature.md.log` |
| `Add auth` | `.dispatch/logs/issue-Add-auth.log` |

### Log format

Each line follows the format:

```
[2025-01-15T10:30:45.123Z] [INFO] Generating spec for #42...
```

Structured entries (prompts, responses) include separator lines (`─` for
prompt/response boundaries, `═` for phase transitions) for readability.

### Accessing logs for debugging

To investigate a failed spec generation:

```bash
# List all log files
ls .dispatch/logs/

# View log for issue #42
cat .dispatch/logs/issue-42.log

# Search for errors across all logs
grep -l "\[ERROR\]" .dispatch/logs/
```

### Log retention

There is **no automatic log cleanup**. Log files persist in `.dispatch/logs/`
indefinitely across runs. Subsequent runs for the same issue ID append to
(or overwrite) the existing log file. To reclaim disk space, delete the
`.dispatch/logs/` directory manually.

### When logging is inactive

When `--verbose` is not set, no `FileLogger` is created and no log files are
written. The `fileLoggerStorage.getStore()` calls return `undefined`, and
the optional chaining (`?.`) skips all logging operations with zero overhead.

---

## Node.js crypto (randomUUID)

**Used in:** `src/agents/spec.ts` (temp file naming)
**Official docs:** [Node.js crypto.randomUUID](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions)

The `randomUUID()` function from Node.js `node:crypto` generates unique
temporary file names for the spec agent's temp-file strategy.

### How it is used

At `src/agents/spec.ts:96`, the agent generates a temp filename:

```
const tmpFilename = `spec-${randomUUID()}.md`;
```

This produces filenames like `spec-a1b2c3d4-e5f6-7890-abcd-ef1234567890.md`
in the `.dispatch/tmp/` directory. Each spec generation gets a unique temp
file, enabling safe concurrent processing.

### UUID collision risk

UUIDv4 (used by `randomUUID()`) generates 122 bits of randomness. The
probability of a collision is astronomically low — even with 1 billion UUIDs,
the collision probability is approximately 10⁻¹⁹. For practical spec
generation batch sizes (even thousands of items), UUID collisions are not a
concern.

### Node.js version requirements

`crypto.randomUUID()` was added in Node.js 19.0.0 and backported to
Node.js 16.7.0+. Since dispatch requires Node.js >= 20.12.0 (per
`package.json` `engines` field), `randomUUID()` is always available.

### Entropy in CI/container environments

`randomUUID()` uses the operating system's cryptographic random number
generator (`/dev/urandom` on Linux, `CryptGenRandom` on Windows). Modern
CI environments and containers provide adequate entropy. Unlike older
`/dev/random` implementations, `/dev/urandom` does not block on low entropy
and is suitable for non-cryptographic uniqueness guarantees like temp file
naming.

## Related documentation

- [Spec Generation Overview](./overview.md) — Pipeline architecture, input
  modes, concurrency, and output format
- [Spec Agent](./spec-agent.md) — Spec agent implementation details
- [Issue Fetching](../issue-fetching/overview.md) — Fetcher architecture and
  data normalization
- [GitHub Fetcher](../issue-fetching/github-fetcher.md) — GitHub CLI
  integration details
- [Azure DevOps Fetcher](../issue-fetching/azdevops-fetcher.md) — Azure
  DevOps fetcher shim (delegates to datasource layer)
- [Datasource Overview](../datasource-system/overview.md) — Datasource
  abstraction, auto-detection, and `IssueDetails` interface
- [Datasource Integrations](../datasource-system/integrations.md) — How
  datasource integrations work with spec generation
- [Provider Abstraction](../provider-system/overview.md) — Provider
  lifecycle and backend implementations
- [Provider Timeouts](../provider-system/overview.md#prompt-timeouts-and-cancellation) —
  Timeout limitations for provider `prompt()` calls
- [CLI Argument Parser](../cli-orchestration/cli.md) — `--spec` mode flags
  and exit codes
- [Configuration](../cli-orchestration/configuration.md) — Persistent config
  for `source`, `provider`, and other settings
- [Shared Utilities — Slugify](../shared-utilities/slugify.md) — Slug
  generation used for spec output filenames
- [Shared Utilities — Timeout](../shared-utilities/timeout.md) — `withTimeout`
  deadline wrapper used for fetch operations
- [Logger](../shared-types/logger.md) — Structured logging facade used for
  spec generation progress and error reporting
- [Cleanup Registry](../shared-types/cleanup.md) — Process-level cleanup
  safety net for provider resources
- [Spec Generator Tests](../testing/spec-generator-tests.md) — Test suite
  covering spec generation utility functions
- [Batch Confirmation](../prereqs-and-safety/confirm-large-batch.md) — Large
  batch threshold logic and confirmation prompt details
- [Testing Overview](../testing/overview.md) — Project-wide test framework
  and test coverage map including spec generator tests
