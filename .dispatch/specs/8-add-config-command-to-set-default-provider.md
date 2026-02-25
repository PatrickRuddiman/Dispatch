# Add config command to set default provider (#8)

> Add a `dispatch config` subcommand and `~/.dispatch/config.json` persistence layer so users can set sticky defaults for commonly-used flags instead of repeating them on every invocation.

## Context

Dispatch is a TypeScript CLI tool (ESM, Node >= 18) built with `tsup`, tested with Vitest, and distributed as the `dispatch` binary. The entire CLI is driven by a single entry file `src/cli.ts` containing a hand-rolled argument parser (`parseArgs`), a `main()` function that routes between dispatch mode and spec mode, a `CliArgs` interface, and a `HELP` string.

Key modules involved in this change:

| Module | Role |
|--------|------|
| `src/cli.ts` | Entry point — `parseArgs()` function, `main()` function, `CliArgs` interface, `HELP` constant. Currently has no subcommand routing; the first positional arg becomes the glob pattern. `parseArgs` uses a while loop over argv, validates `--provider` against `PROVIDER_NAMES` and `--source` against `ISSUE_SOURCE_NAMES`, and calls `process.exit(1)` on invalid values. |
| `src/provider.ts` | Exports `ProviderName` type (`"opencode" \| "copilot"`) and the `ProviderInstance` interface |
| `src/providers/index.ts` | Exports `PROVIDER_NAMES` array (derived via `Object.keys()` from a `Record<ProviderName, BootFn>` map) and `bootProvider()` |
| `src/issue-fetcher.ts` | Exports `IssueSourceName` type (`"github" \| "azdevops"`) and the `IssueFetcher` interface |
| `src/issue-fetchers/index.ts` | Exports `ISSUE_SOURCE_NAMES` array (same registry pattern as providers) and `getIssueFetcher()` |
| `src/logger.ts` | Exports `log` object with `.info` (blue), `.success` (green), `.warn` (yellow), `.error` (red via `console.error`), `.dim`, `.debug` (verbose-gated) methods — all using `chalk` |
| `src/parser.test.ts` | The only existing test file — establishes all testing conventions |
| `src/agents/orchestrator.ts` | Core dispatch pipeline, consumes `CliArgs` fields (provider, concurrency, dryRun, etc.) |
| `src/spec-generator.ts` | Handles `--spec` mode, consumes `CliArgs` fields (spec, issueSource, org, project, provider, etc.) |

The project follows a **registry pattern**: types live in standalone files (`provider.ts`, `issue-fetcher.ts`), implementations in subdirectories (`providers/`, `issue-fetchers/`), and registries in `index.ts` files that export name arrays used for CLI validation and help text. All local imports use `.js` extension suffixes per ESM conventions.

There is currently **no persistent configuration mechanism** — every option must be supplied on each invocation. The `.dispatch/` directory already exists in the project root (used for spec output files) but there is no user-level `~/.dispatch/` directory.

## Why

Users who consistently work with the same provider (e.g. `copilot`), issue source, or Azure DevOps org/project must repeat those flags on every `dispatch` call. This is tedious and error-prone. A config file with a simple `dispatch config set provider copilot` workflow eliminates that friction while preserving the ability to override any individual run via CLI flags.

## Approach

### 1. New `src/config.ts` module — config data layer

Create a standalone config module that owns all config file I/O and validation. This follows the project's convention of isolating concerns into focused modules. The module should:

- Define a `DispatchConfig` interface covering only the "sticky" options that make sense to persist: `provider`, `concurrency`, `source` (issue source), `org`, `project`, `serverUrl`. Explicitly **exclude** per-invocation flags like `--dry-run`, `--no-plan`, `--verbose`, `--cwd`, `--pattern`, `--spec`, `--output-dir` — these are session-specific and should not be persisted.
- Provide a `getConfigPath()` function returning `~/.dispatch/config.json` (using `os.homedir()` from `node:os`). Accept an optional override path parameter so tests can redirect to a tmpdir without touching the real home directory.
- Provide async `loadConfig()` that reads and JSON-parses the file, returning an empty object (`{}`) if the file doesn't exist or contains invalid JSON. Should accept an optional config dir path parameter.
- Provide async `saveConfig()` that writes the config as pretty-printed JSON (`JSON.stringify(config, null, 2)`), creating the parent directory if needed (using `mkdir` with `{ recursive: true }`). Should accept an optional config dir path parameter.
- Export a `CONFIG_KEYS` array listing the valid config key names, for use in validation and help text.
- Provide validation that checks constrained-value keys (`provider`, `source`) against the existing registries (`PROVIDER_NAMES`, `ISSUE_SOURCE_NAMES`). The `concurrency` key should validate as a positive integer. Free-form string keys (`org`, `project`, `serverUrl`) need only basic presence/non-empty validation.
- Use **only Node.js built-ins** (`node:fs/promises`, `node:os`, `node:path`) — no new dependencies.

### 2. Subcommand routing in `main()`

Rather than adding a full subcommand framework, detect `config` as the first positional argument in `main()` **before** the existing help/version/spec/dispatch routing. When detected, delegate to a config handler function and exit. This is a minimal, contained change to `src/cli.ts` that avoids restructuring the existing argument parsing logic.

The detection should happen on the raw `process.argv.slice(2)` array before it's passed to `parseArgs`, since `parseArgs` would treat `config` as a glob pattern and `set`/`get` etc. as unknown flags. Pass the remaining argv tokens (after `config`) to the handler so it can parse the operation and its arguments.

### 3. Config sub-operations handler

Implement the `config` subcommand with these operations (inspired by `git config` and `npm config`):

- `dispatch config set <key> <value>` — validate the key against `CONFIG_KEYS`, validate the value against the appropriate registry (if applicable), then persist. Print a success message using `log.success`.
- `dispatch config get <key>` — print the current value for a key. Use plain `console.log` for pipe-friendly output. Print nothing (or a dim message) if the key is not set.
- `dispatch config list` — print all current config key-value pairs. Use plain `console.log` for pipe-friendly output. Handle the empty config case gracefully.
- `dispatch config reset` — delete the config file entirely. Print a success message.
- `dispatch config path` — print the config file path. Use plain `console.log` for pipe-friendly output.

The handler should live as an exported `handleConfigCommand` function, either in `src/config.ts` or in a separate file if module size warrants it. Use the `log` module for error messages and success confirmations. Use `process.exit(1)` for validation errors, consistent with how `parseArgs` handles invalid input.

### 4. Config-to-CLI-args merge layer

After `parseArgs()` returns in `main()`, load the config file and apply its stored values as defaults **beneath** explicitly-supplied CLI flags. The precedence chain must be:

**CLI flag > config file > hardcoded default**

To detect "user explicitly passed this flag" vs "it's just the hardcoded default", `parseArgs` needs to track which flags were explicitly set during parsing. A `Set<string>` of explicitly-provided flag names should be populated as each flag is encountered during the argv iteration. This set should be returned alongside the `CliArgs` object (e.g., as a tuple `[CliArgs, Set<string>]` or as a wrapper object with both properties).

The merge logic iterates over the config keys and only applies the config value when the corresponding CLI flag was **not** in the explicit set. Key mapping between config keys and `CliArgs` fields:

| Config key | `CliArgs` field | Notes |
|-----------|----------------|-------|
| `provider` | `provider` | Validate against `PROVIDER_NAMES` |
| `concurrency` | `concurrency` | Parse as number |
| `source` | `issueSource` | Validate against `ISSUE_SOURCE_NAMES` |
| `org` | `org` | Free-form string |
| `project` | `project` | Free-form string |
| `serverUrl` | `serverUrl` | Free-form string |

The `CliArgs` interface shape must remain unchanged — all downstream consumers (`orchestrator.orchestrate()`, `generateSpecs()`) continue to receive the same typed object. The merge is purely about filling in defaults from config before passing `args` to those consumers.

### 5. Help text update

Add a new section to the `HELP` string documenting the `config` subcommand and its operations. Follow the existing formatting style (2-space indent, aligned columns). Add config-related examples to the existing Examples section at the bottom.

### 6. Tests

Add `src/config.test.ts` following the established conventions in `src/parser.test.ts`:

- Import from `vitest` (`describe`, `it`, `expect`, `afterEach`)
- Use `mkdtemp(join(tmpdir(), "dispatch-test-"))` for isolated file I/O with cleanup via `rm(tmpDir, { recursive: true, force: true })` in `afterEach`
- Override the config path in tests via the optional path parameter on `loadConfig`/`saveConfig`
- Test groups covering: config file I/O (load missing file, load valid file, load corrupt JSON, save and round-trip, directory auto-creation), validation (valid/invalid keys, valid/invalid values for constrained keys like provider and source, concurrency validation), merge precedence (CLI > config > default for each configurable field), config operations (set valid key, set invalid key, set invalid value, get existing key, get missing key, list with populated config, list with empty config, reset, path)

## Integration Points

- **`CliArgs` interface** (`src/cli.ts`): Shape must remain unchanged. The merge layer fills in fields before downstream use. All downstream consumers (`orchestrator.orchestrate()`, `generateSpecs()`) are unaffected.
- **`parseArgs` function** (`src/cli.ts`): Must be extended to track which flags were explicitly set. The return value changes (to include the explicit-flags set) but the `CliArgs` portion stays the same. All call sites of `parseArgs` (currently only `main()`) must be updated.
- **`ProviderName` type and `PROVIDER_NAMES` array** (`src/provider.ts`, `src/providers/index.ts`): Used to validate `provider` config values. Import `PROVIDER_NAMES` in the config module.
- **`IssueSourceName` type and `ISSUE_SOURCE_NAMES` array** (`src/issue-fetcher.ts`, `src/issue-fetchers/index.ts`): Used to validate `source` config values. Import `ISSUE_SOURCE_NAMES` in the config module.
- **`log` object** (`src/logger.ts`): Use for error/success/dim output in the config handler. Use plain `console.log` for `get`/`list`/`path` output so it's pipe-friendly.
- **`main()` routing** (`src/cli.ts`): Add `config` subcommand detection before the existing spec/dispatch branching. The `config` keyword must be checked on raw argv before `parseArgs` is called, since `parseArgs` would misinterpret `config` as a glob pattern.
- **`HELP` string** (`src/cli.ts`): Extend with a config subcommand section and examples.
- **Test conventions** (`src/parser.test.ts`): Co-located `.test.ts` files, `describe`/`it`/`expect`/`afterEach` from Vitest, tmpdir-based I/O isolation with `"dispatch-test-"` prefix and `rm` cleanup, helper functions for repetitive test setup.
- **ESM import convention**: All local imports must use `.js` extension suffix (e.g., `import { log } from "./logger.js"`).
- **Build system** (`tsup.config.ts`): No changes needed — tsup bundles everything reachable from `src/cli.ts`.
- **No new dependencies**: Use only `node:fs/promises`, `node:os`, `node:path`.

## Tasks

- [x] **Create `src/config.ts` with the config data layer** — Define the `DispatchConfig` interface, `CONFIG_KEYS` array, `getConfigPath()`, `loadConfig()`, `saveConfig()`, and validation functions. This module is the foundation all other tasks depend on. Accept an optional config directory path parameter on I/O functions so tests can redirect to a tmpdir. Validate constrained keys (`provider`, `source`) against the existing `PROVIDER_NAMES` and `ISSUE_SOURCE_NAMES` registries. Validate `concurrency` as a positive integer. Use only Node.js built-ins.

- [ ] **Implement config sub-operations handler** — Build a `handleConfigCommand(argv: string[])` function that implements `set`, `get`, `list`, `reset`, and `path` operations. Validate keys against `CONFIG_KEYS` and values against the appropriate registries for constrained keys. Use `log` for error/success output and plain `console.log` for pipe-friendly output (`get`, `list`, `path`). Exit with code 1 on validation errors, consistent with `parseArgs` error handling.

- [ ] **Add `config` subcommand routing in `src/cli.ts`** — Detect `config` as the first positional argument in `main()` on the raw argv before calling `parseArgs`. Delegate to `handleConfigCommand` with the remaining tokens and exit. This must happen before `parseArgs` processes the argv, since `parseArgs` would treat `config` as a glob pattern.

- [ ] **Extend `parseArgs` to track explicitly-set flags** — Modify `parseArgs` in `src/cli.ts` to maintain a `Set<string>` of flag names that were explicitly provided on the command line. Populate the set as each `--flag` is encountered during the while-loop iteration. Return this set alongside the `CliArgs` object. The `CliArgs` interface shape must not change.

- [ ] **Add config-to-CLI-args merge layer in `src/cli.ts`** — After `parseArgs()` returns in `main()`, call `loadConfig()` and apply stored config values as defaults for any `CliArgs` field whose corresponding flag was not in the explicit-flags set. Handle the config key to `CliArgs` field name mapping (e.g., `source` config key maps to `issueSource` field). Enforce precedence: CLI flag > config file > hardcoded default.

- [ ] **Update `HELP` string and examples** — Add a `Config:` section to the `HELP` constant documenting `dispatch config set|get|list|reset|path` with brief descriptions. Add `dispatch config set provider copilot`, `dispatch config list`, and `dispatch config reset` to the Examples section. Follow the existing 2-space indent and aligned-column formatting.

- [ ] **Add `src/config.test.ts` with Vitest tests** — Cover: loading a missing/empty/valid/corrupt config file, saving and round-tripping config, directory auto-creation on save, validation of keys and values against registries, concurrency validation, merge precedence (CLI > config > default for each configurable field), and the set/get/list/reset/path operations including error cases. Use tmpdir isolation with `"dispatch-test-"` prefix and `afterEach` cleanup. Follow all conventions from `src/parser.test.ts`.

## References

- GitHub Issue: https://github.com/PatrickRuddiman/Dispatch/issues/8
- `git config` CLI design (inspiration for subcommand ergonomics): https://git-scm.com/docs/git-config
- `npm config` CLI design (inspiration for set/get/list): https://docs.npmjs.com/cli/v10/commands/npm-config
- Node.js `node:fs/promises` API: https://nodejs.org/api/fs.html#promises-api
