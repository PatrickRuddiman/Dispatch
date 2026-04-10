# Config Resolution

The `_resolve-config.ts` module provides `loadMcpConfig()`, the shared
configuration resolution function used by all MCP tools that interact with the
dispatch or spec pipelines. It enforces strict provider requirements for the
headless MCP context and auto-detects the datasource from the git remote when
not explicitly configured.

**Source file:** `src/mcp/tools/_resolve-config.ts`

## Function signature

```
loadMcpConfig(
  cwd: string,
  overrides?: { provider?: string; source?: string },
): Promise<DispatchConfig>
```

**Parameters:**

- `cwd` — The working directory. Config is loaded from `{cwd}/.dispatch/config.json`.
- `overrides` — Optional caller-provided values that take priority over the
  config file. Typically populated from tool arguments (e.g., the `provider`
  and `source` parameters on `dispatch_run`).

**Returns:** A `DispatchConfig` object with all fields merged from the config
file and overrides.

**Throws:** If no provider is configured in either overrides or the config
file. The error message directs users to run `dispatch config`.

## Resolution chain

The function resolves configuration in a three-step chain:

### Step 1: Load config file

Calls `loadConfig(join(cwd, ".dispatch"))` from `src/config.ts`. This reads
`.dispatch/config.json` and returns `{}` if the file is missing or contains
invalid JSON.

### Step 2: Resolve provider (required)

```
provider = overrides?.provider ?? config.provider
```

If neither overrides nor config provide a provider, the function throws:

> Missing required configuration: provider. Run 'dispatch config' to set up defaults.

This is the critical difference from the CLI's config resolution. The CLI can
fall back to an interactive wizard (`runInteractiveConfigWizard()`) that
prompts the user to select a provider. MCP tools run in a headless context
where interactive prompts are not possible, so the provider must be
pre-configured.

### Step 3: Resolve source (optional)

```
source = overrides?.source ?? config.source ?? detectDatasource(cwd)
```

Unlike provider, source is optional. If not provided in overrides or config,
the function attempts to auto-detect it from the git remote URL using
`detectDatasource()` from `src/datasources/index.ts`. This function examines
the git remote origin and determines the datasource type:

- GitHub remotes (`github.com`) → `"github"`
- Azure DevOps remotes (`dev.azure.com` or `visualstudio.com`) → `"azdevops"`
- No remote or unrecognized → returns `undefined`, leaving `source` unset

If auto-detection also fails, `source` remains `undefined` in the returned
config. Tools that require a source (e.g., `dispatch_dry_run`, `issues_list`)
check for this and return an error.

## Comparison with CLI config resolution

| Aspect | CLI (`loadConfig` + wizard) | MCP (`loadMcpConfig`) |
|--------|---------------------------|----------------------|
| Provider missing | Interactive wizard prompts user | Throws error |
| Source missing | Interactive wizard prompts user | Auto-detect from git remote |
| Config file missing | Returns `{}`, wizard fills in | Returns `{}`, throws on missing provider |
| Overrides | CLI flags | Tool arguments |
| Interactive prompts | Yes | Never |

## Usage across tools

The following tools call `loadMcpConfig()`:

| Tool | Provider override | Source override |
|------|------------------|----------------|
| `dispatch_run` | `args.provider` | `args.source` |
| `dispatch_dry_run` | None | `args.source` |
| `spec_generate` | `args.provider` | `args.source` |
| `run_retry` | `args.provider` | None |
| `task_retry` | `args.provider` | None |

Note that `config_get`, `config_set`, `status_get`, `runs_list`,
`spec_list`, `spec_read`, `spec_runs_list`, `spec_run_status`, `issues_list`,
and `issues_fetch` do **not** use `loadMcpConfig()`. They either access the
config file directly via `loadConfig()` or do not need configuration at all.

## Error handling

The `loadMcpConfig()` function itself only throws for missing provider. All
other config loading errors (missing file, invalid JSON) are handled by the
underlying `loadConfig()` which returns `{}`.

Callers wrap `loadMcpConfig()` in a try/catch and return the error as an MCP
error response:

```
try {
  config = await loadMcpConfig(cwd, { provider: args.provider });
} catch (err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    isError: true,
  };
}
```

## Related documentation

- [MCP Tools Overview](./overview.md) — Tool catalog showing which tools use
  config resolution
- [Fork-Run IPC Bridge](./fork-run-ipc.md) — The other shared utility that
  tools call after config resolution
- [Configuration](../cli-orchestration/configuration.md) — Full config system
  including the interactive wizard
- [Config Tools](./config-tools.md) — `config_get` and `config_set` for
  reading and writing config values
- [Datasource System](../datasource-system/overview.md) — `detectDatasource()`
  auto-detection logic
- [Provider System](../provider-system/overview.md) — Provider names and
  validation used during config resolution
