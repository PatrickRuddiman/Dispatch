# Authentication and Security

This document covers how each provider authenticates with its backend API, the
permission bypass model used across all providers, and the security implications
of running Dispatch as an automated agent orchestrator.

## Authentication by provider

### Claude (`@anthropic-ai/claude-agent-sdk`)

The Claude provider does not reference credentials in its code. The SDK reads
`ANTHROPIC_API_KEY` from the environment automatically. No validation occurs
at boot time -- an invalid or missing key surfaces as an error on the first
`session.send()` call.

**Setup**:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Get a key from the [Anthropic Console](https://platform.claude.com/).

**Alternative authentication** (via the SDK, not Dispatch code):

| Environment variable | Backend |
|---------------------|---------|
| `CLAUDE_CODE_USE_BEDROCK=1` | Amazon Bedrock (uses AWS credentials) |
| `CLAUDE_CODE_USE_VERTEX=1` | Google Vertex AI (uses Google Cloud credentials) |
| `CLAUDE_CODE_USE_FOUNDRY=1` | Microsoft Azure AI Foundry (uses Azure credentials) |

See the [Anthropic docs](https://docs.anthropic.com/en/docs/claude-code/sdk)
for provider-specific credential setup.

### Codex (`@openai/codex`)

The Codex SDK supports two authentication methods:

| Method | Configuration |
|--------|---------------|
| **ChatGPT sign-in** (recommended) | Run `codex` interactively, select "Sign in with ChatGPT" |
| **API key** | Set `OPENAI_API_KEY` environment variable |

**Setup (API key)**:

```sh
export OPENAI_API_KEY=sk-...
```

The provider code does not reference any API key. Like Claude, all
authentication is delegated to the SDK. Invalid credentials surface on the
first `agent.run()` call.

### Copilot (`@github/copilot-sdk`)

The Copilot provider documents three authentication paths
(`src/providers/copilot.ts:8-11`), checked in this precedence order:

| Priority | Method | Description |
|----------|--------|-------------|
| 1 | Logged-in CLI user | Default. Authenticate via `copilot /login` (device flow or browser-based OAuth). |
| 2 | `COPILOT_GITHUB_TOKEN` | Environment variable with a GitHub personal access token. |
| 3 | `GH_TOKEN` | Standard GitHub CLI token environment variable. |
| 4 | `GITHUB_TOKEN` | Commonly used in CI environments. |

**Which takes precedence?** If a logged-in CLI user session exists, it is used
first. Environment variables are checked in the order listed above: the SDK
uses the first one it finds. If both `COPILOT_GITHUB_TOKEN` and `GH_TOKEN`
are set, `COPILOT_GITHUB_TOKEN` takes precedence.

**Token requirements**: When using a personal access token, create a
[fine-grained token](https://github.com/settings/personal-access-tokens/new)
with the **Copilot Requests** permission enabled.

**Token rotation**:

- **CLI login**: Token refresh is handled automatically by the SDK through
  GitHub's OAuth flow.
- **Environment variables**: Replace the token value in your environment.
  Active sessions continue using the old token; new sessions use the updated
  value.

See the [Copilot backend guide](../provider-system/copilot-backend.md#authentication)
for additional details.

### OpenCode (`@opencode-ai/sdk`)

OpenCode has its own multi-provider configuration layer. It does not use a
single API key -- instead, it supports multiple LLM providers (Anthropic,
OpenAI, etc.), each with their own credentials.

The `listModels()` function (`src/providers/opencode.ts:67-72`) filters
providers by `source` field (`"env"`, `"config"`, or `"custom"`), indicating
that OpenCode reads provider configuration from environment variables, config
files, and custom sources.

**Setup**:

1. Run `opencode` and use the `/connect` command to configure an LLM provider.
2. Alternatively, set API keys for your preferred provider in your environment
   (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

See the [OpenCode providers docs](https://opencode.ai/docs/providers/) for
details on configuring individual LLM providers.

When connecting to an existing OpenCode server via `--server-url`, the server
may require the `OPENCODE_SERVER_PASSWORD` environment variable for
authentication.

## Permission bypass rationale

All four providers bypass permission and approval checks for file operations,
shell commands, and other tool invocations. This is a deliberate design choice
rooted in Dispatch's architecture as an **automated, headless orchestrator**.

### What each provider does

| Provider | Mechanism | Source |
|----------|-----------|--------|
| Claude | `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true` | `src/providers/claude.ts:71-72` |
| Codex | `approvalPolicy: "full-auto"` and `getCommandConfirmation: async () => ({ approved: true })` | `src/providers/codex.ts:88-91` |
| Copilot | `onPermissionRequest: approveAll` (imported from the SDK) | `src/providers/copilot.ts:101` |
| OpenCode | No explicit permission config; inherits OpenCode's default behavior | `src/providers/opencode.ts` |

### Why bypass permissions

Dispatch runs as a fully automated pipeline with no human in the loop. The
[planner](../agent-system/planner-agent.md) and
[dispatcher](../agent-system/executor-agent.md) agents need unrestricted
filesystem and tool access to:

- Read and explore the codebase to understand task requirements
- Edit source files to implement changes
- Run shell commands (build, test, lint) to verify changes
- Commit and push changes to a branch

If the agent paused for permission approval, the automated pipeline would
deadlock -- there is no interactive user to click "approve."

### Security boundaries

Despite the permission bypass, the risk is bounded by several factors:

1. **Worktree isolation**: Tasks are typically executed in a
   [git worktree](../git-and-worktree/worktree-management.md), not the main
   working tree. This limits the blast radius of file modifications.

2. **Branch-and-PR workflow**: All changes are committed to a feature branch
   and submitted as a pull request for human review before merging. The agent
   cannot merge its own changes.

3. **Session isolation**: Each task gets its own
   [session](../provider-system/overview.md#session-isolation-model) with
   separate conversation history. One task's agent cannot interfere with
   another's.

4. **Process-level constraints**: The agent runs with the same OS-level
   permissions as the user who started Dispatch. It cannot escalate privileges
   beyond what the user account allows.

5. **Pipeline-level timeouts**: The
   [orchestrator](../cli-orchestration/orchestrator.md) imposes timeouts
   (`--plan-timeout`, `--spec-timeout`) that kill stuck or runaway agents.

### What the agent can do

With permissions bypassed, the AI agent has full access to:

- **File system**: Read, write, create, and delete files within the working
  directory (and any paths accessible to the process).
- **Shell commands**: Execute arbitrary commands including package installation,
  builds, and system utilities.
- **Network**: Make HTTP requests (e.g., `curl`, `wget`) if the underlying
  tools permit it.

### What the agent cannot do

- **Merge changes**: Changes go through a PR review process.
- **Access other repositories**: The agent operates within the current
  repository's working directory.
- **Escalate OS privileges**: The agent runs with the invoking user's
  permissions.
- **Persist across runs**: Sessions are ephemeral; no state carries over
  between Dispatch runs.

### Recommendations for sensitive environments

If you need tighter control over agent permissions:

1. Run Dispatch in a containerized environment (Docker) with restricted
   filesystem and network access.
2. Use a dedicated service account with minimal OS-level permissions.
3. Review the
   [worktree management](../git-and-worktree/worktree-management.md)
   documentation to understand file isolation boundaries.
4. For the Claude provider, the SDK supports more granular permission modes
   (e.g., `acceptEdits` for read-only + edit-only access). However, this
   would require modifying the provider source code and would prevent shell
   command execution.

## Credential storage summary

| Credential | Storage location | Managed by |
|-----------|-----------------|------------|
| `ANTHROPIC_API_KEY` | Environment variable | User |
| `OPENAI_API_KEY` | Environment variable | User |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | Environment variable | User |
| Copilot CLI OAuth token | SDK-managed (system keychain or config file) | `@github/copilot-sdk` |
| OpenCode provider keys | OpenCode config (`~/.config/opencode/`) | OpenCode CLI |
| GitHub OAuth token (datasource) | `~/.dispatch/auth.json` | Dispatch (see [auth helpers](../git-and-worktree/overview.md)) |
| Azure DevOps token (datasource) | `~/.dispatch/auth.json` | Dispatch |

Provider credentials are never stored by Dispatch itself. Each SDK manages its
own authentication flow. The `~/.dispatch/auth.json` file stores only
[datasource](../datasource-system/overview.md) authentication tokens, not
provider API keys.

## Related documentation

- [Provider Implementations Overview](./overview.md) -- comparison of all four
  providers
- [Claude Backend](./claude-backend.md) -- Claude authentication details
- [Codex Backend](./codex-backend.md) -- Codex authentication details
- [Copilot Backend](../provider-system/copilot-backend.md) -- Copilot
  authentication details
- [OpenCode Backend](../provider-system/opencode-backend.md) -- OpenCode
  authentication details
- [Pool Failover](../provider-system/pool-and-failover.md) -- how throttle errors trigger failover
- [Provider System Overview](../provider-system/overview.md) -- interface
  contract and session isolation
- [Worktree Management](../git-and-worktree/worktree-management.md) --
  filesystem isolation for agent tasks
