# URL Parsing Tests

Tests for the remote URL parsing functions in `src/datasources/index.ts`: `parseAzDevOpsRemoteUrl` and `parseGitHubRemoteUrl`. These functions determine which datasource backend to use and extract organization/project or owner/repo metadata from git remote URLs.

**Test files:**
- `src/tests/datasource-url.test.ts` (202 lines, 2 describe blocks) -- focused URL parsing tests
- `src/tests/datasource.test.ts` (relevant sections) -- additional `parseAzDevOpsRemoteUrl` edge cases

## What is tested

The URL parsers are the entry point for datasource auto-detection. When a user runs Dispatch in a git repository, the remote URL determines which datasource is activated (GitHub, Azure DevOps, or fallback to local markdown). These tests validate all supported URL formats, including legacy formats, credential-embedded URLs, and edge cases.

## parseAzDevOpsRemoteUrl

Extracts `{ orgUrl, project }` from Azure DevOps git remote URLs. The `orgUrl` is always normalized to the `https://dev.azure.com/{org}` format regardless of input format.

### Supported URL formats

| Format | Example | orgUrl | project |
|--------|---------|--------|---------|
| HTTPS (dev.azure.com) | `https://dev.azure.com/myorg/myproject/_git/myrepo` | `https://dev.azure.com/myorg` | `myproject` |
| HTTPS with userinfo | `https://user@dev.azure.com/myorg/myproject/_git/myrepo` | `https://dev.azure.com/myorg` | `myproject` |
| SSH | `git@ssh.dev.azure.com:v3/myorg/myproject/myrepo` | `https://dev.azure.com/myorg` | `myproject` |
| Legacy (visualstudio.com) | `https://myorg.visualstudio.com/myproject/_git/myrepo` | `https://dev.azure.com/myorg` | `myproject` |
| Legacy with DefaultCollection | `https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo` | `https://dev.azure.com/myorg` | `myproject` |

### Normalization

All URL formats are normalized to `https://dev.azure.com/{org}` for the organization URL. This ensures consistent SDK connection URLs regardless of how the git remote was configured. Legacy `visualstudio.com` URLs have the org name extracted from the subdomain.

### Case insensitivity

Both hostname and path matching are case-insensitive. The org and project names preserve their original casing from the URL.

### URL-encoded characters

URL-encoded characters in org and project names are decoded:
- `my%20org` -> `my org`
- `my%20project` -> `my project`

See: `src/tests/datasource.test.ts:502-680`

### Rejected inputs

Returns `null` for:
- GitHub URLs (`https://github.com/...`)
- GitLab URLs (`https://gitlab.com/...`)
- Bitbucket URLs (`https://bitbucket.org/...`)
- Empty string
- Malformed URLs missing `_git` segment
- SSH URLs missing `v3` prefix
- Plain text that is not a URL
- URLs with only an org (no project)

See: `src/tests/datasource-url.test.ts:37-57`, `src/tests/datasource.test.ts:629-679`

## parseGitHubRemoteUrl

Extracts `{ owner, repo }` from GitHub git remote URLs. Handles both HTTPS and SSH formats, with and without `.git` suffix.

### Supported URL formats

| Format | Example | owner | repo |
|--------|---------|-------|------|
| HTTPS with .git | `https://github.com/owner/repo.git` | `owner` | `repo` |
| HTTPS without .git | `https://github.com/owner/repo` | `owner` | `repo` |
| HTTPS with trailing slash | `https://github.com/owner/repo/` | `owner` | `repo` |
| SSH (scp-style) with .git | `git@github.com:owner/repo.git` | `owner` | `repo` |
| SSH (scp-style) without .git | `git@github.com:owner/repo` | `owner` | `repo` |
| SSH (url-style) with .git | `ssh://git@github.com/owner/repo.git` | `owner` | `repo` |
| SSH (url-style) without .git | `ssh://git@github.com/owner/repo` | `owner` | `repo` |
| HTTPS with user@ | `https://user@github.com/owner/repo.git` | `owner` | `repo` |
| HTTPS with user:password@ | `https://user:token@github.com/owner/repo.git` | `owner` | `repo` |
| HTTPS with PAT token | `https://x-access-token:ghp_abc123@github.com/myorg/myrepo` | `myorg` | `myrepo` |

### Repository names with dots

Repository names containing dots are handled correctly:
- `my.repo.name.git` -> repo is `my.repo.name` (only trailing `.git` stripped)
- `my.repo.name` (no .git) -> repo is `my.repo.name`

### Credential handling

HTTPS URLs with embedded credentials (userinfo before `@`) are parsed correctly. The credentials are stripped during parsing -- only the owner and repo are extracted. This is important for CI environments that embed PAT tokens in clone URLs.

See: `src/tests/datasource-url.test.ts:174-202`

### Rejected inputs

Returns `null` for:
- Azure DevOps URLs
- GitLab URLs
- Other non-GitHub URLs
- Empty string

See: `src/tests/datasource-url.test.ts:109-123`

## How URL parsing connects to datasource detection

The URL parsers are used by two systems:

1. **Auto-detection (`detectDatasource`):** Tests the remote URL against `SOURCE_PATTERNS` regex array. The first match determines the datasource. GitHub matches `github.com`, Azure DevOps matches `dev.azure.com` or `visualstudio.com`.

2. **Metadata extraction:** Once the datasource is selected, the appropriate parser extracts the org/project or owner/repo needed for API calls. This metadata is used for authentication setup and API endpoint construction.

```mermaid
flowchart LR
    A[git remote get-url origin] --> B[getGitRemoteUrl]
    B --> C{detectDatasource}
    C -->|github.com| D[parseGitHubRemoteUrl]
    C -->|dev.azure.com| E[parseAzDevOpsRemoteUrl]
    C -->|visualstudio.com| E
    C -->|No match| F[Fallback to md]
    D --> G["{ owner, repo }"]
    E --> H["{ orgUrl, project }"]
```

See: `src/datasources/index.ts:74-99`

## Related documentation

- [Datasource test suite overview](./datasource-tests.md)
- [Azure DevOps datasource tests](./azdevops-datasource-tests.md)
- [GitHub datasource tests](./github-datasource-tests.md)
- [Datasource system architecture](../datasource-system/)
- [Datasource System Overview](../datasource-system/overview.md) -- how URL
  parsing fits into datasource auto-detection
- [Configuration](../cli-orchestration/configuration.md) -- where
  auto-detected datasource values are stored
- [Auth Tests](./auth-tests.md) -- authentication tests that depend on
  URL-parsed metadata (owner, repo, orgUrl, project)