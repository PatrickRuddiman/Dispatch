# Authentication

The authentication module (`src/helpers/auth.ts`, 205 lines) provides OAuth
device-flow authentication for two platforms -- GitHub and Azure DevOps. Tokens
are cached at `~/.dispatch/auth.json` so users authenticate once per platform
until tokens expire. The module exposes three main functions: `getGithubOctokit`,
`getAzureConnection`, and `ensureAuthReady`.

## What it does

The module solves a specific sequencing problem: Dispatch pipelines need
authenticated API clients before the TUI or batch output takes over stdout. The
`ensureAuthReady` function is called early in the pipeline startup, while stdout
is still free, so that device-code prompts ("Enter code XXXX-YYYY at
https://github.com/login/device") can be displayed to the user. After
authentication completes, the cached token is used silently for all subsequent
API calls within the run.

## How it works

### Token cache

The auth cache file lives at `~/.dispatch/auth.json` (constructed via
`path.join(os.homedir(), ".dispatch", "auth.json")`). The file stores a
simple JSON structure:

```json
{
  "github": {
    "token": "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "azure": {
    "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIs...",
    "expiresAt": "2026-04-09T18:30:00.000Z"
  }
}
```

Key security properties:

- **File permissions**: On non-Windows platforms, the file is written with
  `chmod(0o600)` (owner-only read/write). The chmod call is wrapped in a
  try/catch because it may fail on restricted filesystems; the token is
  already written at that point.
- **Home directory placement**: Tokens live in `~/.dispatch/` rather than in
  the project directory, preventing accidental commits to version control.
- **No encryption**: Tokens are stored as plaintext JSON. This matches the
  approach used by tools like `gh` (GitHub CLI) and `az` (Azure CLI) which
  also store tokens in the user's home directory.

### GitHub OAuth device flow

`getGithubOctokit()` authenticates via the GitHub OAuth device flow
([RFC 8628](https://tools.ietf.org/html/rfc8628)):

1. Check the cache for an existing GitHub token. If present, return a new
   `Octokit` instance immediately.
2. Initiate the device flow using `@octokit/auth-oauth-device` with:
   - **Client ID**: `Ov23liUMP1Oyg811IF58` (a public OAuth App ID, not a
     secret)
   - **Client type**: `oauth-app`
   - **Scopes**: `["repo"]` (full repository access for branch creation,
     pushes, and PR creation)
3. Display the verification code to the user via the auth prompt handler
   (or `log.info` if no handler is set), and open the verification URL in
   the default browser using the `open` package.
4. The `@octokit/auth-oauth-device` library polls GitHub's token endpoint
   until the user completes authentication.
5. Cache the resulting token and return an authenticated `Octokit` instance.

GitHub OAuth tokens obtained via this flow **do not expire** by default (unlike
GitHub App tokens which expire after 1 hour). The cached token remains valid
until the user revokes it at
`https://github.com/settings/connections/applications/Ov23liUMP1Oyg811IF58`.

### Azure DevOps device-code flow

`getAzureConnection(orgUrl)` authenticates via the Azure AD device-code flow:

1. Check the cache for an existing Azure token. If present **and** the token
   will not expire within the next 5 minutes (the `EXPIRY_BUFFER_MS`),
   return a new `WebApi` connection immediately.
2. Create a `DeviceCodeCredential` from `@azure/identity` with:
   - **Tenant ID**: `"organizations"` (restricts to work/school accounts;
     personal Microsoft accounts are not supported by Azure DevOps)
   - **Client ID**: `150a3098-01dd-4126-8b10-5e7f77492e5c` (public Azure AD
     app registration)
   - **Scope**: `499b84ac-1321-427f-aa17-267ca6975798/.default` (the Azure
     DevOps default API scope)
3. Display a prompt that includes a note about work/school account
   requirements, and open the verification URL in the browser.
4. Call `credential.getToken(scope)` which blocks until the user completes
   authentication.
5. Cache the token with its `expiresAt` timestamp and return a `WebApi`
   connection using a bearer token handler.

The 5-minute expiry buffer (`EXPIRY_BUFFER_MS = 5 * 60 * 1000`) ensures that
tokens are refreshed before they actually expire, preventing mid-pipeline
authentication failures.

### The ensureAuthReady dispatcher

`ensureAuthReady(source, cwd, org?)` is the shared entry point called by both
the dispatch and spec pipelines. It determines which authentication flow to
trigger based on the datasource:

| Datasource | Behavior |
|------------|----------|
| `"github"` | Reads the git remote URL, parses it as a GitHub URL via `parseGitHubRemoteUrl`. If valid, calls `getGithubOctokit()` to trigger auth. |
| `"azdevops"` | Reads the git remote URL (or uses the provided `org` argument), parses it as an Azure DevOps URL via `parseAzDevOpsRemoteUrl` to extract the org URL, then calls `getAzureConnection(orgUrl)`. |
| `undefined` or `"md"` | No authentication needed; returns immediately. |

If the git remote URL cannot be parsed or is missing, warnings are logged and
authentication is skipped rather than failing. This allows offline or
misconfigured environments to proceed with the pipeline (authentication errors
will surface later when actual API calls are attempted).

### Auth prompt handler

The module supports routing device-code prompts to the TUI instead of stdout.
The `setAuthPromptHandler(handler)` function registers a callback that receives
prompt messages. When set, prompts are routed through this handler instead of
`log.info()`. Passing `null` clears the handler.

This is necessary because the TUI takes over stdout during pipeline execution.
If a token expires mid-run and requires re-authentication, the prompt needs to
appear within the TUI's rendering context rather than corrupting its output.

## Auth token lifecycle

```mermaid
sequenceDiagram
    participant Pipeline as Pipeline Startup
    participant Auth as auth.ts
    participant Cache as ~/.dispatch/auth.json
    participant Browser as User Browser
    participant API as GitHub/Azure API

    Pipeline->>Auth: ensureAuthReady(source, cwd)
    Auth->>Cache: loadAuthCache()

    alt Token cached and valid
        Cache-->>Auth: { token, expiresAt? }
        Auth-->>Pipeline: Authenticated client
    else No token or expired
        Auth->>API: Initiate device-code flow
        API-->>Auth: { user_code, verification_uri }
        Auth->>Browser: open(verification_uri)
        Note over Auth,Browser: Display code to user<br/>via prompt handler or log.info
        Auth->>API: Poll for completion
        API-->>Auth: { token, expiresAt }
        Auth->>Cache: saveAuthCache({ token })
        Note over Cache: chmod 0o600 (non-Windows)
        Auth-->>Pipeline: Authenticated client
    end
```

## OAuth configuration constants

The OAuth configuration values are defined in `src/constants.ts` and are
**public client identifiers**, not secrets:

| Constant | Value | Purpose |
|----------|-------|---------|
| `GITHUB_CLIENT_ID` | `Ov23liUMP1Oyg811IF58` | GitHub OAuth App client ID |
| `AZURE_CLIENT_ID` | `150a3098-01dd-4126-8b10-5e7f77492e5c` | Azure AD application (client) ID |
| `AZURE_TENANT_ID` | `"organizations"` | Restricts to work/school Entra ID accounts |
| `AZURE_DEVOPS_SCOPE` | `499b84ac-1321-427f-aa17-267ca6975798/.default` | Azure DevOps default API scope |

The `"organizations"` tenant ID is significant: it prevents personal Microsoft
accounts from being used, because Azure DevOps does not support them for API
access. Using `"common"` (which allows both personal and work accounts) would
allow users to authenticate with an account that cannot actually access Azure
DevOps, producing confusing 401 errors downstream.

## Why GitHub tokens do not store an expiry

GitHub OAuth tokens obtained via the device flow are long-lived and do not
include an expiration timestamp. The `AuthCache` interface reflects this
asymmetry: `github` stores only `{ token: string }` while `azure` stores
`{ token: string; expiresAt: string }`.

If the user revokes the GitHub token, the next API call will fail with a 401
error. Dispatch does not currently handle this gracefully -- the user would
need to manually delete `~/.dispatch/auth.json` (or just the `github` key)
and re-run. A future improvement could catch 401 responses and re-trigger
the device flow.

## Why the browser opens automatically

Both authentication flows call `open(verificationUri).catch(() => {})` to
launch the verification URL in the user's default browser. The `.catch(() => {})`
silences errors on headless environments (CI servers, SSH sessions) where no
browser is available. In those cases, the user must manually copy the URL from
the terminal prompt.

The `open` package (npm: `open`) is a cross-platform utility that delegates to
platform-specific commands: `xdg-open` on Linux, `open` on macOS, and
`start` on Windows.

## Error handling

| Scenario | Behavior |
|----------|----------|
| Cache file missing or unreadable | Returns empty object `{}`; triggers fresh auth |
| Cache file contains invalid JSON | Returns empty object `{}`; triggers fresh auth |
| Azure token near expiry (< 5 min remaining) | Triggers fresh auth flow |
| Azure `getToken` returns null | Throws with descriptive message |
| Git remote URL missing | Logs warning, skips auth |
| Git remote URL not recognized | Logs warning, skips auth |
| Browser fails to open | Silenced; user must open URL manually |
| chmod fails on restricted filesystem | Silenced; token already written |

## Operational guidance

### Revoking access

To revoke Dispatch's access to your accounts:

- **GitHub**: Visit
  `https://github.com/settings/connections/applications/Ov23liUMP1Oyg811IF58`
  and revoke access.
- **Azure DevOps**: Revoke via the Azure portal under Entra ID > Enterprise
  applications, or simply wait for the token to expire.

After revoking, delete `~/.dispatch/auth.json` to force re-authentication on
the next run.

### Clearing cached tokens

```bash
# Remove all cached tokens
rm ~/.dispatch/auth.json

# Remove only the GitHub token (keep Azure)
# Edit the file and remove the "github" key

# Remove only the Azure token (keep GitHub)
# Edit the file and remove the "azure" key
```

### Headless environments

In environments without a browser (CI, SSH), the device-code URL and user code
will be printed to the terminal. You must manually open the URL in a browser on
another device and enter the code. The authentication flow will complete once
the code is entered, regardless of which device the browser is on.

## Related documentation

- [Overview](./overview.md) -- Group-level summary and architectural position
- [Integrations](./integrations.md) -- Detailed SDK documentation for Octokit,
  Azure Identity, Azure DevOps Node API, and the `open` package
- [Datasource System](../datasource-system/overview.md) -- The datasource
  abstraction that determines which auth flow to use
- [GitHub Datasource](../datasource-system/github-datasource.md) -- Uses the
  `Octokit` instance returned by `getGithubOctokit()`
- [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) --
  Uses the `WebApi` connection returned by `getAzureConnection()`
- [CLI & Orchestration](../cli-orchestration/overview.md) -- The runner that
  calls `ensureAuthReady` during startup
- [Dispatch Pipeline](../cli-orchestration/dispatch-pipeline.md) -- The
  pipeline that requires authenticated clients
- [Spec Generation](../spec-generation/overview.md) -- The spec pipeline that
  also calls `ensureAuthReady`
- [Prerequisites & Safety](../prereqs-and-safety/overview.md) -- Pre-flight
  validation that runs alongside auth checks
