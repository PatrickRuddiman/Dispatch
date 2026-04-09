# Authentication

Dispatch uses OAuth device-code flows to authenticate with GitHub and Azure
DevOps issue trackers. Tokens are cached locally so users authenticate once
per platform until tokens expire. The authentication system is implemented
in `src/helpers/auth.ts` and uses constants from `src/constants.ts`.

## What it does

The authentication system provides transparent token management for Dispatch's
datasource integrations:

1. **GitHub**: Obtains a GitHub OAuth token with `repo` scope via the GitHub
   [device-code flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
   The token is used by the [GitHub datasource](../datasource-system/github-datasource.md)
   to fetch issues and create pull requests.

2. **Azure DevOps**: Obtains an Azure AD access token via the
   [device-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
   with the `organizations` tenant. The token is used by the
   [Azure DevOps datasource](../datasource-system/azdevops-datasource.md)
   to fetch work items.

3. **Markdown datasource**: No authentication is needed. The `md` datasource
   operates on local files.

## Why it exists

Without cached authentication, users would need to re-authenticate on every
`dispatch` invocation. The device-code flow was chosen because it works in
terminal environments without requiring a web server callback (unlike
authorization code flow), and the token cache avoids re-prompting.

## Key source files

| File | Role |
|------|------|
| `src/helpers/auth.ts` | Token cache I/O, GitHub and Azure device-code flows, `ensureAuthReady()` |
| `src/constants.ts` | OAuth client IDs, Azure tenant ID, Azure DevOps API scope |

## Token storage

Tokens are cached at a **user-global** path (not project-local):

```
~/.dispatch/auth.json
```

The `AUTH_PATH` constant (`src/helpers/auth.ts:37`) computes this using
`join(homedir(), ".dispatch", "auth.json")`. The `~/.dispatch/` directory is
created automatically by `saveAuthCache()` via `mkdir(dirname(AUTH_PATH), { recursive: true })`.

### File format

```json
{
  "github": {
    "token": "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "azure": {
    "token": "eyJ0eXAiOi...",
    "expiresAt": "2025-01-15T10:30:00.000Z"
  }
}
```

Both fields are optional. The file may contain only GitHub, only Azure, or
both.

### File permissions

On Unix systems, `saveAuthCache()` calls `chmod(AUTH_PATH, 0o600)` after
writing (`src/helpers/auth.ts:68`), restricting the file to owner read-write
only. This prevents other users on the system from reading the cached tokens.
On Windows, the `chmod` call is skipped (`process.platform !== "win32"` guard).
If `chmod` fails (e.g., on restricted filesystems), the error is silently
swallowed — the token has already been written.

### No encryption

Tokens are stored as plaintext JSON. This matches the approach used by tools
like `gh` (GitHub CLI) and `az` (Azure CLI) which also store tokens in the
user's home directory. Security relies on filesystem permissions (`0o600`) and
home directory placement (preventing accidental commits to version control).

### Corruption handling

`loadAuthCache()` (`src/helpers/auth.ts:54-61`) wraps the file read and JSON
parse in a `try/catch`. If the file does not exist, contains invalid JSON, or
cannot be read, the function returns an empty object (`{}`). This means:

- A corrupted auth cache triggers a fresh device-code flow on the next run.
- There is no warning that cached tokens were ignored.
- The user must re-authenticate.

This is the same silent-fallback pattern used by the
[config file](configuration.md#what-happens-when-the-config-file-is-corrupted-or-contains-invalid-json).

## Shared entry point: `ensureAuthReady()`

The `ensureAuthReady()` function (`src/helpers/auth.ts:177-205`) is the
shared entry point used by both the dispatch/spec pipelines and the
[config wizard](configuration.md#wizard-step-details). It pre-authenticates
the selected datasource before the TUI or batch output takes over stdout.

```mermaid
flowchart TD
    A["ensureAuthReady(source, cwd, org)"] --> B{"source?"}
    B -->|github| C["getGitRemoteUrl(cwd)"]
    C --> D{"Remote is GitHub?"}
    D -->|Yes| E["getGithubOctokit()"]
    D -->|No remote| F["log.warn — skip"]
    D -->|Not GitHub| F
    E --> G["Token cached?"]
    G -->|Yes| H["Return Octokit (instant)"]
    G -->|No| I["GitHub device-code flow"]

    B -->|azdevops| J{"org URL provided?"}
    J -->|Yes| K["getAzureConnection(orgUrl)"]
    J -->|No| L["getGitRemoteUrl(cwd)"]
    L --> M{"Remote is Azure DevOps?"}
    M -->|Yes| N["Extract orgUrl → getAzureConnection()"]
    M -->|No| O["log.warn — skip"]
    K --> P["Token cached + valid?"]
    P -->|Yes| Q["Return WebApi (instant)"]
    P -->|No/expired| R["Azure device-code flow"]

    B -->|md| S["No auth needed — return"]
    B -->|undefined| S
```

For cached, valid tokens, `ensureAuthReady()` resolves almost instantly (just
a file read + JSON parse). For new or expired credentials, it triggers the
interactive device-code flow while stdout is still free.

If the git remote URL cannot be parsed or is missing, warnings are logged and
authentication is skipped rather than failing. This allows offline or
misconfigured environments to proceed with the pipeline (authentication errors
will surface later when actual API calls are attempted).

## GitHub OAuth device flow

### How it works

The GitHub flow uses `@octokit/auth-oauth-device` (`src/helpers/auth.ts:88-101`),
implementing [RFC 8628](https://tools.ietf.org/html/rfc8628) (OAuth 2.0
Device Authorization Grant):

1. Dispatch calls `createOAuthDeviceAuth()` with the public GitHub client ID
   (`Ov23liUMP1Oyg811IF58` from `src/constants.ts:9`) and `scopes: ["repo"]`.

2. The library contacts GitHub's device authorization endpoint and receives a
   user code and verification URL.

3. The `onVerification` callback displays the code and URL to the user:
   `Enter code XXXX-XXXX at https://github.com/login/device`. It also calls
   `open(verification_uri)` to open the URL in the default browser
   automatically.

4. The library polls GitHub's token endpoint at the specified interval until
   the user completes authorization (or the code expires after 15 minutes).

5. On success, the OAuth token is cached to `~/.dispatch/auth.json` and an
   `Octokit` instance is returned.

### OAuth scope

The `repo` scope is requested, which grants:

- Read access to issues (for issue fetching)
- Write access to create branches and pull requests
- Read/write access to repository contents (for push)

### Token lifetime

GitHub OAuth tokens do not expire unless explicitly revoked. The cached token
remains valid indefinitely until the user revokes it.

The `AuthCache` interface reflects the asymmetry between GitHub and Azure
tokens: `github` stores only `{ token: string }` while `azure` stores
`{ token: string; expiresAt: string }`. If the user revokes the GitHub token,
the next API call will fail with a 401 error. Dispatch does not currently
handle this gracefully — the user must manually delete `~/.dispatch/auth.json`
(or just the `github` key) and re-run.

### Public client ID

The GitHub client ID (`Ov23liUMP1Oyg811IF58`) is a **public** identifier, not
a secret. It identifies the Dispatch OAuth application registered on GitHub.
Device-code flow does not require a client secret — it relies on user
presence at the verification URL to prove authorization.

## Azure AD device-code flow

### How it works

The Azure flow uses `DeviceCodeCredential` from `@azure/identity`
(`src/helpers/auth.ts:133-148`):

1. Dispatch creates a `DeviceCodeCredential` with:
   - `tenantId: "organizations"` — restricts sign-in to work/school
     (Microsoft Entra ID) accounts
   - `clientId: "150a3098-01dd-4126-8b10-5e7f77492e5c"` — the Dispatch
     Azure AD application

2. The `userPromptCallback` displays the device code and verification URL,
   prepended with a note: *"Azure DevOps requires a work or school account
   (personal Microsoft accounts are not supported)."*

3. The credential calls `getToken(AZURE_DEVOPS_SCOPE)` where
   `AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default"`
   (`src/constants.ts:22`). This scope is the well-known resource ID for
   Azure DevOps.

4. On success, the access token and its expiration timestamp are cached to
   `~/.dispatch/auth.json`.

### Tenant restriction

The `AZURE_TENANT_ID` is set to `"organizations"` (`src/constants.ts:19`),
not `"common"`. This means:

- **Work/school accounts** (Microsoft Entra ID) can sign in.
- **Personal Microsoft accounts** (outlook.com, hotmail.com) are rejected.

This restriction exists because Azure DevOps does not support personal
Microsoft accounts for API access. If a user attempts to sign in with a
personal account, Azure AD returns an error at the verification URL.

### Token expiration and refresh

Azure AD tokens have a limited lifetime (typically 1 hour). The auth cache
stores the expiration timestamp. On subsequent runs, `getAzureConnection()`
checks whether the cached token expires within 5 minutes
(`EXPIRY_BUFFER_MS = 5 * 60 * 1000` at `src/helpers/auth.ts:40`):

- If the token is still valid (more than 5 minutes remaining), the cached
  token is reused immediately.
- If the token is expired or about to expire, a fresh device-code flow is
  triggered.

There is currently no refresh token flow — expired tokens always trigger a
new device-code authentication.

### Public client ID

The Azure client ID (`150a3098-01dd-4126-8b10-5e7f77492e5c`) is a public
identifier. Device-code flow for public clients does not require a client
secret. The client ID identifies the Dispatch application registration in
Azure AD.

## Auth prompt routing

The `setAuthPromptHandler()` function (`src/helpers/auth.ts:50-52`) allows
callers to route device-code prompts to a custom handler instead of
`log.info()`. This is used to display auth prompts within the TUI when
authentication is needed during a pipeline run. When no handler is set
(default), prompts go to the standard logger.

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

## Error handling summary

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

## Constants reference

The `src/constants.ts` file contains the following public OAuth constants:

| Constant | Value | Purpose |
|----------|-------|---------|
| `GITHUB_CLIENT_ID` | `Ov23liUMP1Oyg811IF58` | GitHub OAuth App client ID |
| `AZURE_CLIENT_ID` | `150a3098-01dd-4126-8b10-5e7f77492e5c` | Azure AD application (client) ID |
| `AZURE_TENANT_ID` | `organizations` | Restricts Azure sign-in to work/school accounts |
| `AZURE_DEVOPS_SCOPE` | `499b84ac-1321-427f-aa17-267ca6975798/.default` | Azure DevOps API scope (well-known resource ID) |

All four values are **public client identifiers**, not secrets. They are
bundled with the CLI so users do not need to register their own OAuth
applications.

## Troubleshooting

### GitHub device flow does not complete

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Browser does not open | `open` package failed to launch browser | Navigate manually to `https://github.com/login/device` |
| Code expired | User did not complete authorization within 15 minutes | Re-run the command to get a fresh code |
| `401` errors after auth | Token was revoked or the OAuth app was removed | Delete `~/.dispatch/auth.json` and re-authenticate |

### Azure device flow does not complete

| Symptom | Cause | Resolution |
|---------|-------|------------|
| "Only work or school accounts" error | User signed in with a personal Microsoft account | Sign in with a work/school (Entra ID) account |
| Code expired | User did not complete authorization within 15 minutes | Re-run the command to get a fresh code |
| Token expired quickly | Azure AD tokens expire after ~1 hour | Normal behavior; Dispatch triggers re-auth when the token is within 5 minutes of expiry |
| `403` on Azure DevOps API | User lacks permissions on the Azure DevOps project | Verify user has access to the configured organization and project |

### Deleting cached tokens

To force re-authentication, delete the auth cache:

```bash
# Remove all cached tokens
rm ~/.dispatch/auth.json

# Remove only the GitHub token (keep Azure)
# Edit the file and remove the "github" key

# Remove only the Azure token (keep GitHub)
# Edit the file and remove the "azure" key
```

The next `dispatch` invocation triggers fresh device-code flows for both
GitHub and Azure DevOps as needed.

### Revoking access

To revoke Dispatch's access to your accounts:

- **GitHub**: Visit
  `https://github.com/settings/connections/applications/Ov23liUMP1Oyg811IF58`
  and revoke access.
- **Azure DevOps**: Revoke via the Azure portal under Entra ID > Enterprise
  applications, or wait for the token to expire.

After revoking, delete `~/.dispatch/auth.json` to force re-authentication on
the next run.

### Headless environments

In environments without a browser (CI, SSH), the device-code URL and user code
will be printed to the terminal. You must manually open the URL in a browser on
another device and enter the code. The authentication flow will complete once
the code is entered, regardless of which device the browser is on.

## Related documentation

- [Configuration](configuration.md) -- config wizard calls `ensureAuthReady()`
  during setup
- [CLI](cli.md) -- subcommand routing for `config` (which triggers auth)
- [GitHub Datasource](../datasource-system/github-datasource.md) -- uses
  `getGithubOctokit()` for API access
- [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) --
  uses `getAzureConnection()` for API access
- [Integrations](integrations.md) -- `@octokit/auth-oauth-device`,
  `@azure/identity`, and `open` package details
- [Datasource System](../datasource-system/overview.md) -- the datasource
  abstraction that determines which auth flow to use
- [Spec Generation](../spec-generation/overview.md) -- the spec pipeline that
  also calls `ensureAuthReady`
- [Prerequisites & Safety](../prereqs-and-safety/overview.md) -- pre-flight
  validation that runs alongside auth checks
