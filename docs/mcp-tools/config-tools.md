# Config Tools

The config tools provide MCP clients with read and write access to the Dispatch
configuration file at `.dispatch/config.json`. They enable AI assistants to
inspect current settings and modify individual configuration values without
requiring the interactive CLI wizard.

**Source file:** `src/mcp/tools/config.ts`

## Tools

### config_get

Reads the current Dispatch configuration from `.dispatch/config.json` and
returns it as a JSON object.

**Parameters:** None.

**Response:** A JSON object containing all configuration fields except
`nextIssueId`, which is excluded because it is an internal auto-increment
counter for the markdown datasource and is not useful for agent consumption.

**Example response:**

```json
{
  "provider": "copilot",
  "model": "claude-sonnet-4",
  "source": "github",
  "concurrency": 4
}
```

**Behavior notes:**

- Returns `{}` if the config file does not exist or contains invalid JSON
  (this is the behavior of the underlying `loadConfig()` function).
- The `nextIssueId` field is stripped from the response via destructuring
  before serialization.

### config_set

Sets a single configuration value in `.dispatch/config.json`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `enum` | Yes | Configuration key to set. Must be one of the valid `CONFIG_KEYS`. |
| `value` | `string` | Yes | Value to set. Numeric values must be passed as strings (e.g., `"4"` for concurrency). |

**Valid keys:** `provider`, `model`, `fastProvider`, `fastModel`, `agents`,
`source`, `planTimeout`, `specTimeout`, `specWarnTimeout`,
`specKillTimeout`, `concurrency`, `org`, `project`, `workItemType`,
`iteration`, `area`, `username`.

**Response on success:**

```json
{
  "updated": { "concurrency": 4 },
  "config": { "provider": "copilot", "concurrency": 4 }
}
```

The response includes both the updated key-value pair and the full config
(excluding `nextIssueId`).

**Numeric keys:** The following keys are automatically converted from string
to number: `planTimeout`, `specTimeout`, `specWarnTimeout`,
`specKillTimeout`, `concurrency`.

**Error cases:**

1. **`agents` key blocked**: Returns an error because `agents` requires
   object-level configuration (per-agent provider/model overrides). The error
   message directs users to edit `.dispatch/config.json` directly or use
   `dispatch config`.

2. **Validation failure**: The `validateConfigValue()` function from
   `src/config.ts` checks:
    - `provider` and `fastProvider` must be valid provider names
    - `source` must be a valid datasource name
    - `model` and `fastModel` must be non-empty strings
    - Numeric keys must be within defined bounds (e.g., `concurrency` 1-64)
    - `username` must be alphanumeric with hyphens, max 20 characters
    - `org`, `project`, `workItemType`, `iteration`, `area` must be non-empty

3. **File I/O error**: Any filesystem error during load or save is caught and
   returned as an error response.

## Configuration bounds

Numeric configuration values are constrained to these ranges:

| Key | Min | Max | Unit |
|-----|-----|-----|------|
| `planTimeout` | 1 | 120 | minutes |
| `specTimeout` | 1 | 120 | minutes |
| `specWarnTimeout` | 1 | 120 | minutes |
| `specKillTimeout` | 1 | 120 | minutes |
| `concurrency` | 1 | 64 | parallel tasks |

## Why agents is blocked

The `agents` configuration key stores a nested object structure with per-agent
provider/model overrides:

```json
{
  "agents": {
    "planner": { "provider": "copilot", "model": "claude-haiku-4" },
    "executor": { "model": "claude-sonnet-4" }
  }
}
```

The `config_set` tool accepts only scalar string values. Setting `agents`
would require the caller to pass a serialized JSON string, which would be
error-prone and ambiguous. Instead, the tool returns an error directing users
to either edit the config file directly or use the interactive
`dispatch config` CLI command.

## Integration with config system

The config tools import from `src/config.ts`:

| Import | Purpose |
|--------|---------|
| `loadConfig(configDir)` | Load config from disk, returning `{}` on missing/invalid file |
| `saveConfig(config, configDir)` | Write config as pretty-printed JSON, creating directory if needed |
| `validateConfigValue(key, value)` | Validate a value against key-specific rules |
| `CONFIG_KEYS` | Array of valid key names, used as the Zod enum source |

The `configDir` is constructed as `join(cwd, ".dispatch")` where `cwd` is the
working directory passed during tool registration.

## Related documentation

- [MCP Tools Overview](./overview.md) — tool catalog and registration architecture
- [Configuration](../cli-orchestration/configuration.md) — full config system
  documentation including the interactive wizard
- [Config Resolution](./config-resolution.md) — how other tools load and merge
  configuration
- [MCP Server Overview](../mcp-server/overview.md) — server architecture and tool registration lifecycle
- [Markdown Datasource](../datasource-system/markdown-datasource.md) — uses `nextIssueId` from `.dispatch/config.json`
- [Datasource System Overview](../datasource-system/overview.md) — datasource selection driven by the `source` config key
- [Provider System Overview](../provider-system/overview.md) — provider selection driven by the `provider` config key
- [MCP Subcommand](../cli-orchestration/mcp-subcommand.md) — CLI entry point that launches the MCP server exposing these tools
- [MCP State Tests](../testing/mcp-state-tests.md) — test coverage for MCP tool state management
