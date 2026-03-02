# CLI Argument Parser

The CLI entry point (`src/cli.ts`) provides a hand-rolled argument parser that
validates user input, displays help and version information, handles the
`config` subcommand, and delegates all workflow logic to the
[orchestrator](orchestrator.md) via `bootOrchestrator` and `runFromCli`.

## What it does

The CLI is the user-facing surface of `dispatch`. It is documented as part of
the [CLI & Orchestration group](overview.md). It:

1. Intercepts the `config` subcommand before argument parsing (see
   [Configuration](configuration.md)).
2. Parses `process.argv` into a typed `ParsedArgs` object along with an
   `explicitFlags` set that tracks which flags were explicitly provided.
3. Installs `SIGINT` and `SIGTERM` signal handlers for
   [graceful shutdown](configuration.md#graceful-shutdown-and-cleanup).
4. Handles `--help` and `--version` early-exit paths.
5. Boots the orchestrator via `bootOrchestrator({ cwd })` and delegates to
   `orchestrator.runFromCli(args)`, which handles config resolution, mode
   routing (dispatch vs spec), and pipeline execution.
6. Translates the result summary into a POSIX exit code.

## Installation and distribution

The `dispatch` CLI is distributed as the npm package `dispatch`.

### Requirements

- **Node.js >= 18** (`package.json` `engines` field). The tsup build target is
  `node18` (`tsup.config.ts`).
- **ESM only**: The package uses `"type": "module"` in `package.json`. All
  imports use `.js` extensions for ESM compatibility.

### Install methods

```bash
# Global install — adds `dispatch` to PATH
npm install -g dispatch

# Run without installing
npx dispatch

# Local project install
npm install --save-dev dispatch
npx dispatch           # runs via local node_modules/.bin
```

### Binary entry point

The `package.json` `bin` field maps the `dispatch` command to `./dist/cli.js`:

```json
{ "bin": { "dispatch": "./dist/cli.js" } }
```

The tsup build (`tsup.config.ts`) compiles `src/cli.ts` to `dist/cli.js` as a
single ESM bundle with a `#!/usr/bin/env node` shebang banner. Source maps are
enabled (`sourcemap: true`), type declarations are not emitted (`dts: false`),
and code splitting is disabled (`splitting: false`) to produce a single output
file.

### Published files

Only the `dist/` directory is included in the published package (`"files": ["dist"]`
in `package.json`). Source TypeScript files, tests, docs, and configuration
files are excluded from the npm tarball.

### Runtime dependencies

The package has four runtime dependencies:

| Package | Version | Purpose |
|---------|---------|---------|
| `@opencode-ai/sdk` | ^1.2.10 | OpenCode provider SDK |
| `@github/copilot-sdk` | ^0.1.0 | GitHub Copilot provider SDK |
| `chalk` | ^5.4.1 | Terminal color output |
| `glob` | ^11.0.1 | File pattern matching for task discovery |

## Why a custom parser instead of commander/yargs?

The project uses a hand-rolled `parseArgs()` function
(`src/cli.ts:97-232`) rather than an established CLI framework like
[commander](https://github.com/tj/commander.js),
[yargs](https://yargs.js.org/), or
[citty](https://github.com/unjs/citty).

The likely reasons are:

- **Zero dependencies**: The project keeps its dependency footprint minimal.
  The only runtime dependencies are `chalk`, `glob`, and the two provider SDKs.
  Adding a CLI framework would add another dependency (and its transitive
  dependencies) for a relatively simple argument surface.
- **Small option set**: Dispatch has 17 options across two modes. A hand-rolled
  parser for this surface area is straightforward and fits in ~135 lines.
- **Full control**: The parser can exit immediately with targeted error messages
  (e.g., provider validation against [`PROVIDER_NAMES`](../provider-system/provider-overview.md#the-provider-registry)) without mapping through
  a framework's validation API.

### Trade-offs and limitations

The custom parser does **not** handle several edge cases that established
frameworks handle automatically:

| Edge case | Behavior | Framework equivalent |
|-----------|----------|---------------------|
| Combined short flags (`-vh`) | Treated as an unknown option, exits with error | Automatically expanded to `-v -h` |
| Repeated flags (`--dry-run --dry-run`) | Silently accepted, last value wins (booleans are idempotent) | Configurable: error, array, or last-wins |
| `--option=value` syntax | Not supported; treated as an unknown option | Automatically split on `=` |
| Missing value after `--concurrency` | `parseInt(undefined)` returns `NaN`, caught by the `isNaN` check, exits with error | Type-checked with clear error message |
| Missing value after `--provider` | `undefined` fails the `PROVIDER_NAMES.includes()` check, exits with "Unknown provider" | Type-checked with clear error message |
| Missing value after `--server-url` | Silently sets `serverUrl` to `undefined` — this is a bug | Would require a value |
| Missing value after `--cwd` | `resolve(undefined)` returns `process.cwd()` — silent no-op | Would require a value |
| Unknown options starting with `-` | Correctly exits with "Unknown option" error | Configurable behavior |
| Positional arguments | Non-flag arguments are collected into `issueIds[]` (supports multiple positionals) | Positional argument definitions |

**Recommendation**: If the option surface grows significantly, consider
migrating to a lightweight framework. For the current set of options, the
custom parser is adequate but should add `=` splitting and value-presence
checks for `--server-url` and `--cwd`.

## Options reference

### Dispatch mode options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `<issue-id...>` | string (positional, repeatable) | *(none — dispatches all open issues if omitted)* | Issue IDs to dispatch (e.g., `14`, `14,15,16`, or `14 15 16`) |
| `--dry-run` | boolean | `false` | List discovered tasks without executing (see [dry-run mode](orchestrator.md#dry-run-mode)) |
| `--no-plan` | boolean | `false` | Skip the [planner agent](../planning-and-dispatch/planner.md), dispatch tasks directly (see [Planning & Dispatch overview](../planning-and-dispatch/overview.md)) |
| `--no-branch` | boolean | `false` | Skip branch creation, push, and PR lifecycle (see [the --no-branch flag](#the---no-branch-flag)) |
| `--concurrency <n>` | integer | `min(cpus, freeMB/500)` | Maximum parallel dispatches per batch (see [concurrency model](orchestrator.md#concurrency-model) and [default computation](configuration.md#default-concurrency-computation)) |
| `--provider <name>` | string | `"opencode"` | AI agent backend (`opencode` or `copilot`); see [Provider Abstraction](../provider-system/provider-overview.md) |
| `--server-url <url>` | string | *none* | Connect to a running provider server instead of starting one |
| `--plan-timeout <min>` | float | `10` | Planning timeout in minutes. Must be a positive number. Parsed via `parseFloat`. Configurable via `dispatch config set planTimeout`. |
| `--plan-retries <n>` | integer | `1` | Number of retry attempts after planning timeout. Must be a non-negative integer. Parsed via `parseInt`. Configurable via `dispatch config set planRetries`. |
| `--cwd <dir>` | string | `process.cwd()` | Working directory for file discovery and agent execution |
| `--verbose` | boolean | `false` | Show detailed debug output for troubleshooting |
| `-h`, `--help` | boolean | `false` | Show usage information |
| `-v`, `--version` | boolean | `false` | Show version string |

### Spec mode options

Spec mode is activated by passing `--spec` or `--respec`. When active, the
issue IDs are not required and the dispatch-specific flags (`--dry-run`,
`--no-plan`, `--concurrency`) are ignored.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--spec <values...>` | string (one or more) | *none* | Comma-separated issue numbers, multiple space-separated args, glob pattern for local `.md` files, or inline text description. Activates spec mode. See [issue IDs vs glob patterns](configuration.md#the---spec-flag-issue-ids-vs-glob-patterns). |
| `--respec [values...]` | string (zero or more) | *none* | Regenerate existing specs. Accepts the same value types as `--spec` (issue numbers, glob, multiple args), or can be passed with no arguments to regenerate all existing specs. Uses variadic collection — consumes all subsequent non-flag arguments. An empty invocation (`--respec` with no args or immediately followed by another flag) produces an empty array. |
| `--source <name>` | string | *auto-detected* | Datasource: `github`, `azdevops`, or `md`. Auto-detected from `git remote get-url origin` if omitted. See [datasource detection](configuration.md#auto-detection-from-git-remote) and [Datasource Overview](../datasource-system/overview.md). |
| `--org <url>` | string | *none* | Azure DevOps organization URL (e.g., `https://dev.azure.com/myorg`). Required when `--source azdevops`. |
| `--project <name>` | string | *none* | Azure DevOps project name. Required when `--source azdevops`. |
| `--output-dir <dir>` | string | `.dispatch/specs` | Output directory for generated spec files. Resolved to an absolute path. Created automatically if it does not exist. |
| `--provider <name>` | string | `"opencode"` | AI agent backend (shared with dispatch mode) |
| `--server-url <url>` | string | *none* | Connect to a running provider server (shared with dispatch mode) |
| `--plan-timeout <min>` | float | `10` | Planning timeout in minutes (shared with dispatch mode) |
| `--plan-retries <n>` | integer | `1` | Retry attempts after planning timeout (shared with dispatch mode) |

#### Spec mode validation

The `--source` flag is validated against `DATASOURCE_NAMES` (currently
`["github", "azdevops", "md"]`). An unknown value exits with code `1` and a
descriptive error message (`src/cli.ts:157-161`).

When `--source` is omitted, auto-detection runs `git remote get-url origin` and
matches the output against regex patterns for `github.com` (SSH and HTTPS) and
`dev.azure.com` / `*.visualstudio.com` (SSH and HTTPS). If no pattern matches,
the pipeline aborts with an error suggesting `--source` be specified explicitly.
See the [Spec Generation overview](../spec-generation/overview.md) for the
full detection logic.

#### `--spec` and `--respec` variadic parsing

Both `--spec` and `--respec` use variadic collection loops
(`src/cli.ts:134-143` and `src/cli.ts:144-153`) that consume all subsequent
non-flag arguments (arguments not starting with `--`). The collection stops
when the next `--`-prefixed flag is encountered or the argument list is
exhausted.

- **Single value**: stored as a string (e.g., `--spec 42` produces `"42"`)
- **Multiple values**: stored as an array (e.g., `--spec 42 43` produces
  `["42", "43"]`)
- **Empty** (no args before next flag or end of input): produces an empty
  array for `--respec` (e.g., `--respec --verbose` produces `[]`); `--spec`
  with no arguments also produces an empty array.

The `--spec` and `--respec` flags are not mutually exclusive at the parser
level. Both can be set simultaneously in `ParsedArgs`. Mutual exclusion is
enforced downstream by the orchestrator (`src/agents/orchestrator.ts`), which
checks for both and produces an error.

Examples:

```bash
dispatch --respec                        # respec = []     (regenerate all)
dispatch --respec 42                     # respec = "42"   (single issue)
dispatch --respec 42 43 44              # respec = ["42", "43", "44"]
dispatch --respec "specs/*.md"          # respec = "specs/*.md"
dispatch --respec --verbose             # respec = []     (empty, --verbose consumed separately)
dispatch --spec 1,2 --respec 3,4       # spec = "1,2", respec = "3,4" (both set)
```

## The `--server-url` option

The `--server-url` option allows connecting to an already-running AI provider
server rather than starting a new one. The protocol and authentication depend
on the selected provider:

- **OpenCode**: The URL points to an OpenCode server's HTTP API (e.g.,
  `http://localhost:4096`). The `@opencode-ai/sdk` creates a client using
  `createOpencodeClient({ baseUrl: url })`. No separate authentication is
  required — the server handles auth. See the
  [OpenCode Backend](../provider-system/opencode-backend.md) for details.
- **Copilot**: The URL is passed as `cliUrl` to `CopilotClient`. The Copilot
  SDK connects to a Copilot CLI server. Authentication uses the logged-in
  Copilot CLI user, or environment variables `COPILOT_GITHUB_TOKEN`,
  `GH_TOKEN`, or `GITHUB_TOKEN`. See the
  [Copilot Backend](../provider-system/copilot-backend.md#authentication) for
  authentication details.

When `--server-url` is not provided, each provider boots its own server
process and manages its lifecycle internally.

## The `--no-branch` flag

The `--no-branch` flag (`src/cli.ts:128-130`) disables the per-issue branch
lifecycle that the dispatch pipeline normally performs. It is a boolean flag
parsed into `explicitFlags` as `"noBranch"` and passed through to the
orchestrator's `OrchestrateRunOptions.noBranch` field.

### What the branch lifecycle does (when `--no-branch` is *not* set)

When dispatching tasks, the pipeline groups tasks by their source file (each
file corresponds to one issue). For each file that has associated
`IssueDetails` (issue number and title), the pipeline:

1. **Gets the default branch** via `datasource.getDefaultBranch()` (e.g.,
   `main` or `master`).
2. **Builds a branch name** via `datasource.buildBranchName(number, title)` --
   typically `dispatch/<number>-<sanitized-title>`.
3. **Creates and switches to the branch** via
   `datasource.createAndSwitchBranch()`. If the branch already exists, the
   datasource switches to it instead of creating a new one.
4. **Dispatches all tasks** for that issue on the new branch.
5. **Pushes the branch** to the remote via `datasource.pushBranch()`.
6. **Creates a pull request** linking the branch to the issue via
   `datasource.createPullRequest()`.
7. **Switches back** to the default branch via `datasource.switchBranch()`.

Each step is wrapped in `try/catch` with a warning on failure. A branch
creation failure causes the pipeline to continue dispatching tasks on the
current branch (no branch isolation), but push and PR steps are skipped. See
`src/orchestrator/dispatch-pipeline.ts:157-280` for the implementation.

### When to use `--no-branch`

Use `--no-branch` when:

- **You are working on a branch already** and want tasks committed to the
  current branch rather than new per-issue branches.
- **Your workflow manages branches externally** (e.g., a CI pipeline that
  creates branches before invoking `dispatch`).
- **The repository does not have a remote** or push access is not available.
- **Testing or development**: You want to see task results without creating
  git artifacts.

### CLI-only flag

`--no-branch` is a CLI-only flag. It is **not** in `CONFIG_KEYS` and cannot be
persisted via `dispatch config set`. This is intentional -- branch lifecycle
behavior is typically per-invocation rather than a persistent default.

```mermaid
sequenceDiagram
    participant CLI as CLI (cli.ts)
    participant Orch as Orchestrator
    participant Pipeline as dispatch-pipeline.ts
    participant DS as Datasource

    CLI->>Orch: runFromCli({ noBranch: false })
    Orch->>Pipeline: runDispatchPipeline(opts, cwd)

    loop For each issue file
        alt noBranch = false AND issueDetails exist
            Pipeline->>DS: getDefaultBranch()
            DS-->>Pipeline: "main"
            Pipeline->>DS: buildBranchName(number, title)
            DS-->>Pipeline: "dispatch/42-add-auth"
            Pipeline->>DS: createAndSwitchBranch("dispatch/42-add-auth")
        end

        Pipeline->>Pipeline: dispatch tasks (plan + execute)

        alt noBranch = false AND branch was created
            Pipeline->>DS: pushBranch("dispatch/42-add-auth")
            Pipeline->>DS: createPullRequest(branch, number, title)
            DS-->>Pipeline: PR URL
            Pipeline->>DS: switchBranch("main")
        end
    end
```

## Exit code contract

The CLI uses a binary exit code scheme with additional signal codes.
The primary exit logic is at `src/cli.ts:277-278`:

| Exit code | Meaning |
|-----------|---------|
| `0` | All tasks completed successfully (or `--help`/`--version`/`config` was used) |
| `1` | One or more tasks failed, **or** a fatal error occurred |
| `130` | Process received SIGINT (Ctrl+C) |
| `143` | Process received SIGTERM |

There is **no distinction** between partial failure and total failure. If 9 out
of 10 tasks succeed but 1 fails, the exit code is `1`. This follows POSIX
conventions where non-zero indicates "something went wrong," but it means CI
pipelines cannot tell from the exit code alone whether 1% or 100% of tasks
failed.

**Workaround**: Use `--dry-run` to preview the task count, then parse the
[TUI](tui.md) or [logger](../shared-types/logger.md) output for per-task results if you need granular failure
information. A future enhancement could add `--json` output or distinct exit
codes (e.g., `2` for partial failure).

Unhandled exceptions from `main()` are caught by the top-level `.catch()`
handler (`src/cli.ts:281-284`), which logs the error message, calls
`runCleanup()` to release provider resources, and exits with code `1`.

## Version string and tsup define

The version string is currently hardcoded as `"dispatch v0.1.0"` at
`src/cli.ts:267`. The adjacent comment says `// Read version from package.json
at build time via tsup define`, indicating the intent to inject the version at
build time.

However, the tsup configuration (`tsup.config.ts`) does **not** currently
include a `define` block:

```typescript
// tsup.config.ts — current state
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
```

The `define` feature is **not wired up**. The version string in
`package.json` (`"0.1.0"`) and the hardcoded string in `cli.ts` happen to
match, but they are not synchronized automatically.

To wire this up, the tsup config would need:

```typescript
import { readFileSync } from "fs";
const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  // ...existing config...
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
```

Then `src/cli.ts` would become:

```typescript
console.log(`dispatch v${__VERSION__}`);
```

See the [tsup documentation on `define`](https://tsup.egoist.dev/) for details
on build-time constant injection.

## How it works

```mermaid
flowchart TD
    A["process.argv.slice(2)"] --> B{"argv[0] === 'config'?"}
    B -->|Yes| C["handleConfigCommand(argv)<br/>process.exit(0)"]
    B -->|No| D["parseArgs(argv)<br/>→ [ParsedArgs, explicitFlags]"]
    D --> E{"help?"}
    E -->|Yes| F["print HELP, exit 0"]
    E -->|No| G{"version?"}
    G -->|Yes| H["print version, exit 0"]
    G -->|No| I["bootOrchestrator({ cwd })"]
    I --> J["orchestrator.runFromCli(args)"]
    J --> K["resolveCliConfig(args)<br/>merge config + validate"]
    K --> L{"--spec or --respec?"}
    L -->|Yes| M["Spec pipeline"]
    L -->|No| N["Dispatch pipeline"]
    M --> O["Summary"]
    N --> O
    O --> P{"summary.failed > 0?"}
    P -->|Yes| Q["exit 1"]
    P -->|No| R["exit 0"]
    D -.->|validation error| S["log.error(), exit 1"]
    K -.->|missing config| T["log.error(), exit 1"]
```

The key architectural change from earlier versions is that the CLI no longer
directly calls `generateSpecs()` or `orchestrate()`. Instead, it delegates to
`bootOrchestrator()` (`src/cli.ts:272`) which returns an orchestrator instance,
then calls `orchestrator.runFromCli(args)` (`src/cli.ts:274`). The orchestrator
internally calls `resolveCliConfig()` to merge config-file defaults with CLI
flags before routing to the appropriate pipeline. See
[Configuration](configuration.md) for full details on the resolution process.

## Related documentation

- [Configuration](configuration.md) -- persistent config file, three-tier
  precedence, `dispatch config` subcommand, and mandatory validation
- [Orchestrator pipeline](orchestrator.md) -- what happens after the CLI
  delegates to `orchestrator.runFromCli()` in dispatch mode
- [Spec Generation](../spec-generation/overview.md) -- the full spec generation
  pipeline invoked by `--spec` mode
- [Issue Fetching](../issue-fetching/overview.md) -- how issues are retrieved
  from GitHub and Azure DevOps for spec generation
- [Terminal UI](tui.md) -- real-time dashboard rendering during dispatch
- [Integrations](integrations.md) -- tsup build configuration, chalk color
  handling, Node.js fs/promises config I/O
- [Provider Abstraction & Backends](../provider-system/provider-overview.md) -- provider boot
  process and server-url semantics
- [Planning & Dispatch Pipeline](../planning-and-dispatch/overview.md) -- planner,
  dispatcher, and git operations that the orchestrator coordinates
- [Task Parsing & Markdown](../task-parsing/overview.md) -- how markdown task
  files are parsed and mutated
- [Datasource System](../datasource-system/overview.md) -- datasource
  abstraction and `--source` flag semantics
- [Testing Overview](../testing/overview.md) -- test suite structure and
  coverage (config tests cover `--respec` variadic parsing and
  `--spec`/`--respec` mutual exclusion)
