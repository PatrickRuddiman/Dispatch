# Add config command to set default provider (#8)

> Add a `dispatch config` subcommand and `~/.dispatch/config.json` persistence layer so users can set sticky defaults for commonly-used flags (provider, concurrency, source, org, project, etc.) instead of repeating them on every invocation.

## Context

Dispatch is a TypeScript CLI tool (ESM, Node >= 18) built with `tsup`, tested with Vitest, and distributed as the `dispatch` binary. The entire CLI is driven by a single entry file `src/cli.ts` which contains:

- A hand-rolled argument parser (`parseArgs`) that iterates over `process.argv` and populates a local `CliArgs` interface.
- A `main()` function that routes between **dispatch mode** (glob pattern → orchestrator) and **spec mode** (`--spec` → `generateSpecs`).
- A `HELP` string that describes all flags and sub-modes.

Key modules involved:

| Module | Role |
|--------|------|
| `src/cli.ts` | Entry point, `parseArgs`, `main()`, `CliArgs` interface, `HELP` text |
| `src/provider.ts` | `ProviderName` type (`"opencode" \| "copilot"`) |
| `src/providers/index.ts` | `PROVIDER_NAMES` array, `bootProvider()` |
| `src/issue-fetcher.ts` | `IssueSourceName` type (`"github" \| "azdevops"`) |
| `src/issue-fetchers/index.ts` | `ISSUE_SOURCE_NAMES` array, `getIssueFetcher()` |
| `src/logger.ts` | `log` object with `.info`, `.success`, `.error`, `.dim` methods |
| `src/parser.test.ts` | Only existing test file — shows conventions (co-located `.test.ts`, tmpdir for I/O tests, `describe`/`it`/`expect` from Vitest) |

The project follows a **registry pattern**: interfaces in standalone files, implementations in subdirectories, registries in `index.ts` files that export name arrays used for CLI validation and help text. There is currently **no persistent configuration mechanism** — every option must be supplied on each invocation.

## Why

Users who consistently work with the same provider (e.g. `copilot`), the same issue source, or the same Azure DevOps org/project must repeat those flags on every `dispatch` call. This is tedious and error-prone. A config file with a simple `dispatch config set provider copilot` workflow eliminates that friction while preserving the ability to override on any individual run via CLI flags.

## Approach

### 1. New `src/config.ts` module

Create a standalone config module that owns all config file I/O and validation. This follows the project's convention of isolating concerns into focused modules. The module should:

- Define a `DispatchConfig` interface covering the "sticky" options that make sense to persist: `provider`, `concurrency`, `source` (issue source), `org`, `project`, `serverUrl`. Explicitly **exclude** per-invocation flags like `--dry-run`, `--no-plan`, `--verbose`, `--cwd`, `--pattern`, `--spec`, `--output-dir`.
- Provide `getConfigPath()` returning `~/.dispatch/config.json` (using `node:os` `homedir()`).
- Provide async `loadConfig()` that reads and parses the JSON file, returning an empty config object if the file doesn't exist or is invalid.
- Provide async `saveConfig()` that writes the config object as pretty-printed JSON, creating the `~/.dispatch/` directory if needed (`mkdir -p` style with `{ recursive: true }`).
- Provide a `validateConfigKey(key, value)` or similar validation helper that checks values against the existing registries (`PROVIDER_NAMES`, `ISSUE_SOURCE_NAMES`) for the keys that have constrained value sets.
- Export a list of valid config keys (`CONFIG_KEYS`) for use in help text and validation.
- Use **only Node.js built-ins** (`node:fs/promises`, `node:os`, `node:path`) — no new dependencies.

### 2. Subcommand routing in `main()`

Rather than adding a full subcommand framework, detect `config` as the first positional argument in `main()` before the existing spec/dispatch routing. When detected, delegate to a config handler function. This is a minimal, contained change to `src/cli.ts` that avoids restructuring the existing argument parsing.

### 3. Config sub-operations handler

Implement the `config` subcommand with these operations (inspired by `git config` and `npm config`):

- `dispatch config set <key> <value>` — validate and persist a config value
- `dispatch config get <key>` — print the current value for a key
- `dispatch config list` — print all current config values
- `dispatch config reset` — delete the config file entirely
- `dispatch config path` — print the config file path (useful for debugging)

The handler can live in `src/config.ts` itself (as a `handleConfigCommand` function) or in a separate file — the planner can decide based on size. Validation must use the same registries (`PROVIDER_NAMES`, `ISSUE_SOURCE_NAMES`) already used by `parseArgs` to keep behavior consistent.

### 4. Config-to-CLI merge layer

After `parseArgs()` returns, load the config file and apply its values as defaults **beneath** explicitly-supplied CLI flags. The precedence chain must be: **CLI flag > config file > hardcoded default**. This means:

- For `provider`: if the user didn't pass `--provider`, check config, otherwise keep the hardcoded `"opencode"` default.
- For `concurrency`: if the user didn't pass `--concurrency`, check config (but `undefined` is valid — it triggers mode-specific defaults downstream).
- For `source`, `org`, `project`, `serverUrl`: only apply config values when the CLI flag was not supplied.

The key design constraint is that the `CliArgs` interface shape must **not change** — all downstream consumers (`orchestrator.orchestrate()`, `generateSpecs()`) continue to receive the same typed object. The merge is purely about filling in defaults from config before passing `args` to those consumers.

To detect "user explicitly passed this flag" vs "it's just the hardcoded default", `parseArgs` will need to track which flags were explicitly set. A simple approach is a `Set<string>` of explicitly-provided flag names populated during parsing.

### 5. Help text update

Add a new section to the `HELP` string documenting the `config` subcommand and its operations. Follow the existing formatting style (2-space indent, aligned columns, examples section at bottom).

### 6. Tests

Add a `src/config.test.ts` file following the conventions in `src/parser.test.ts`:

- Use `vitest` imports (`describe`, `it`, `expect`, `afterEach`)
- Use `mkdtemp` + `tmpdir` for isolated file I/O tests with cleanup in `afterEach`
- Test groups: config file I/O (load/save/missing file), validation (valid/invalid keys and values), merge precedence (CLI > config > default), config operations (set/get/list/reset)
- Override the config path in tests by accepting an optional path parameter or by having `getConfigPath` be injectable/overridable.

## Integration Points

- **`CliArgs` interface** (`src/cli.ts`): Shape must remain unchanged. The merge layer fills in fields before downstream use.
- **`ProviderName` type and `PROVIDER_NAMES` array** (`src/provider.ts`, `src/providers/index.ts`): Used to validate `provider` config values.
- **`IssueSourceName` type and `ISSUE_SOURCE_NAMES` array** (`src/issue-fetcher.ts`, `src/issue-fetchers/index.ts`): Used to validate `source` config values.
- **`log` object** (`src/logger.ts`): Use for all user-facing output (`.info`, `.success`, `.error`, `.dim`) — not raw `console.log` (except in `config list`/`config get` where plain output may be appropriate for piping).
- **`parseArgs` function** (`src/cli.ts`): Must be extended to track which flags were explicitly set, enabling the merge layer to distinguish "user said `--provider opencode`" from "default is opencode".
- **`main()` routing** (`src/cli.ts`): Add a `config` subcommand check before the existing spec/dispatch branching.
- **`HELP` string** (`src/cli.ts`): Extend with config subcommand documentation.
- **Test conventions** (`src/parser.test.ts`): Co-located `.test.ts` files, `describe`/`it`/`expect` from Vitest, tmpdir-based I/O isolation with cleanup.
- **Build system** (`tsup.config.ts`): No changes needed — tsup bundles everything reachable from `src/cli.ts`.
- **No new dependencies**: Use only `node:fs/promises`, `node:os`, `node:path`.

## Tasks

- [ ] **Create `src/config.ts` with the config data layer** — Define the `DispatchConfig` interface, `CONFIG_KEYS` list, `getConfigPath()`, `loadConfig()`, `saveConfig()`, and validation functions. This module is the foundation all other tasks depend on. Use only Node.js built-ins and validate against existing provider/source registries.

- [ ] **Add `config` subcommand routing in `src/cli.ts`** — Detect `config` as the first positional argument in `main()` before existing spec/dispatch routing. Parse the remaining argv tokens (operation name and arguments) and delegate to the config handler. This is a minimal change to the existing control flow.

- [ ] **Implement config sub-operations (`set`, `get`, `list`, `reset`, `path`)** — Build the `handleConfigCommand` function (in `src/config.ts` or a new `src/config-command.ts`) that handles each operation with proper validation, error messages, and output. Validate values against `PROVIDER_NAMES` and `ISSUE_SOURCE_NAMES` where applicable. Use the `log` module for error output.

- [ ] **Add config-to-CLI-args merge layer in `src/cli.ts`** — After `parseArgs()`, load the config file and apply stored values as defaults for fields not explicitly set via CLI flags. This requires tracking which flags were explicitly provided during parsing (e.g., via a `Set<string>`). Enforce precedence: CLI flag > config file > hardcoded default. The `CliArgs` shape must remain unchanged.

- [ ] **Update `HELP` string and examples** — Add a `Config:` section to the `HELP` constant documenting `dispatch config set|get|list|reset|path` with usage examples. Follow the existing formatting style.

- [ ] **Add `src/config.test.ts` with Vitest tests** — Cover: loading a missing/empty/valid/corrupt config file, saving and round-tripping config, validation of keys and values against registries, merge precedence (CLI > config > default), and the set/get/list/reset operations. Use tmpdir isolation and follow `src/parser.test.ts` conventions.

## References

- GitHub Issue: https://github.com/PatrickRuddiman/Dispatch/issues/8
- `git config` CLI design (inspiration for subcommand ergonomics): https://git-scm.com/docs/git-config
- `npm config` CLI design (inspiration for set/get/list): https://docs.npmjs.com/cli/v10/commands/npm-config
- Node.js `node:fs/promises` API: https://nodejs.org/api/fs.html#promises-api
