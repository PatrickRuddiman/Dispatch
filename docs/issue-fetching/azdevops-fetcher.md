# Azure DevOps Fetcher

The Azure DevOps fetcher (`src/issue-fetchers/azdevops.ts`) retrieves work
item details from Azure DevOps by shelling out to the
[Azure CLI (`az`)](https://learn.microsoft.com/en-us/azure/devops/cli/) with
the `azure-devops` extension. It normalizes the JSON output into the common
[`IssueDetails`](./overview.md#the-issuedetails-interface) interface.

## Prerequisites

### Install the Azure CLI

```bash
# macOS (Homebrew)
brew install azure-cli

# Windows (WinGet)
winget install -e --id Microsoft.AzureCLI

# Linux (apt, Debian/Ubuntu)
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Linux (dnf, Fedora/RHEL)
sudo dnf install azure-cli

# Cross-platform (pip)
pip install azure-cli
```

Verify installation:

```bash
az --version
```

### Install the azure-devops extension

The `az boards` commands require the `azure-devops` extension:

```bash
az extension add --name azure-devops
```

To update an existing installation:

```bash
az extension update --name azure-devops
```

Verify the extension is installed:

```bash
az extension show --name azure-devops
```

**Version compatibility:** The `azure-devops` extension requires Azure CLI
version 2.30.0 or higher. The extension is automatically installed the first
time you run an `az boards` command, but explicit installation is recommended
to catch errors early.

### Authenticate

Sign in to Azure:

```bash
az login
```

This opens a browser for interactive authentication. For CI environments, use
a Personal Access Token (PAT):

```bash
az devops login --organization https://dev.azure.com/myorg
```

When prompted, paste your PAT. The PAT must have **Work Items (Read)** scope.

**Verify authentication:**

```bash
az devops project list --organization https://dev.azure.com/myorg
```

### Configure defaults

Set default organization and project to avoid passing `--org` and `--project`
with every command:

```bash
az devops configure --defaults \
  organization=https://dev.azure.com/myorg \
  project=MyProject
```

These defaults are stored in the Azure CLI configuration file
(`~/.azure/config`) and are used when `--org` and `--project` are not
explicitly provided.

## How `--org` and `--project` are supplied

The Azure DevOps fetcher accepts `org` and `project` as optional fields in
`IssueFetchOptions` (`src/issue-fetcher.ts:42-49`). These flow through from
the CLI flags:

1. **CLI flags** (`--org`, `--project`): Parsed in `src/cli.ts:124-129` and
   passed to `generateSpecs()`.
2. **generateSpecs()** passes them as `IssueFetchOptions.org` and
   `IssueFetchOptions.project` to the fetcher.
3. **The fetcher** conditionally appends `--org` and `--project` to the `az`
   command args (`src/issue-fetchers/azdevops.ts:31-36`).

If neither CLI flags nor `az devops configure` defaults are set, the `az`
command fails with an error like:
`TF401019: The specified project does not exist`.

**Precedence:**

| Source | Priority | Example |
|--------|----------|---------|
| CLI flags (`--org`, `--project`) | Highest | `dispatch --spec 100 --org https://dev.azure.com/myorg --project MyProject` |
| az CLI defaults | Fallback | Set via `az devops configure --defaults` |
| Git config auto-detect | Lowest | The `az` CLI can infer org/project from the git remote if `--detect true` is set (not used by dispatch) |

## How it works

The fetcher makes two CLI calls per work item:

### 1. Fetch work item details

```
az boards work-item show --id <issueId> --output json [--org <url>] [--project <name>]
```

This returns the full work item JSON including all fields and links.

### 2. Fetch comments (non-fatal)

```
az boards work-item relation list-comment --work-item-id <issueId> --output json [--org <url>] [--project <name>]
```

This fetches discussion comments for the work item. **Comment fetching is
intentionally non-fatal** -- if this command fails, the fetcher returns an
empty comments array and proceeds with the rest of the data.

### Field mapping

| Azure DevOps field | `IssueDetails` field | Transformation |
|-------------------|---------------------|----------------|
| `item.id` | `number` | Cast to string, fallback to input `issueId` |
| `fields["System.Title"]` | `title` | Direct, defaults to `""` |
| `fields["System.Description"]` | `body` | Direct (HTML format), defaults to `""` |
| `fields["System.Tags"]` | `labels` | Split by `;`, trimmed, empty strings filtered |
| `fields["System.State"]` | `state` | Direct (e.g., `"Active"`, `"Closed"`) |
| `item._links.html.href` or `item.url` | `url` | HTML link preferred, API URL as fallback |
| `fields["Microsoft.VSTS.Common.AcceptanceCriteria"]` | `acceptanceCriteria` | Direct (HTML format), defaults to `""` |
| Comment `createdBy.displayName` + `text` | `comments[]` | Formatted as `**displayName:** text` |

### Tag parsing

Azure DevOps stores tags as a semicolon-delimited string in the
`System.Tags` field (e.g., `"bug;priority-high;frontend"`). The fetcher splits
on `;`, trims whitespace, and filters empty strings
(`src/issue-fetchers/azdevops.ts:51-54`).

### HTML content in body and acceptance criteria

Azure DevOps stores `System.Description` and
`Microsoft.VSTS.Common.AcceptanceCriteria` as HTML. The fetcher passes this
HTML directly into the `body` and `acceptanceCriteria` fields without
sanitization or conversion to markdown.

The spec generator's AI prompt receives this HTML as-is. The AI agent is
expected to interpret HTML content when generating specs. If HTML causes
problems in practice, a conversion step (e.g., using a library like
`turndown`) could be added to the fetcher.

### Work item ID format

The `issueId` parameter is passed directly to `az boards work-item show --id`.
The Azure CLI expects a **numeric work item ID** (e.g., `100`, `200`).

Prefixes like `AB#100` (the Azure Boards mention format used in pull requests)
are **not stripped** by the fetcher. If you pass `AB#100`, the `az` CLI will
fail because it expects a bare numeric ID.

```bash
# Correct
dispatch --spec 100,200 --source azdevops

# Incorrect — will fail
dispatch --spec AB#100 --source azdevops
```

## Why comment fetching is non-fatal

The `fetchComments()` function (`src/issue-fetchers/azdevops.ts:68-107`)
wraps its entire body in a `try/catch` that returns an empty array on any
error. This is a deliberate design choice:

1. **Extension availability.** The `az boards work-item relation list-comment`
   command may not be available if the `azure-devops` extension is an older
   version or is partially installed. A missing command should not prevent
   work item fetching.

2. **Permission differences.** A user may have read access to work items but
   not to comments (e.g., restricted Azure DevOps permissions). Failing the
   entire fetch because of a comment permission error would be unnecessarily
   strict.

3. **Comments are supplementary.** The core issue data (title, description,
   acceptance criteria) is sufficient for spec generation. Comments add
   context but are not required.

**Trade-off: silent failure.** The current implementation does not log a
warning when comment fetching fails. The error is silently swallowed. This
means a misconfiguration (e.g., missing extension, wrong permissions) that
consistently prevents comment fetching would go unnoticed. Adding a
`log.warn()` call inside the catch block would improve observability without
changing the non-fatal behavior.

## Troubleshooting

### `az` CLI not installed

**Symptom:** Error containing `ENOENT` (file not found).

**Cause:** Node.js `execFile` cannot find the `az` binary on `PATH`.

**Resolution:**

1. Install the Azure CLI (see [Prerequisites](#install-the-azure-cli)).
2. Verify it is on PATH: `which az` (Unix) or `where az` (Windows).
3. Restart your terminal to pick up PATH changes.

### azure-devops extension not installed

**Symptom:** Error containing `'boards' is not a recognized command` or
`The command group 'boards' is not installed`.

**Resolution:**

```bash
az extension add --name azure-devops
```

Verify:

```bash
az extension show --name azure-devops
```

### Authentication failures

**Symptom:** Error containing `TF400813`, `401 Unauthorized`, or
`authentication`.

**Resolution:**

1. Re-authenticate: `az login`
2. For PAT-based auth: `az devops login --organization https://dev.azure.com/myorg`
3. Verify the PAT has **Work Items (Read)** scope.
4. Check PAT expiration date.

### Wrong organization or project

**Symptom:** Error containing `TF401019: The specified project does not exist`
or `TF200016: The following project does not exist`.

**Resolution:**

1. Verify the organization URL (must include `https://dev.azure.com/`).
2. Verify the project name is spelled correctly (case-sensitive).
3. Pass explicitly: `--org https://dev.azure.com/myorg --project MyProject`
4. Or configure defaults: `az devops configure --defaults organization=... project=...`

### Work item not found

**Symptom:** Error containing `TF401232: Work item does not exist`.

**Resolution:**

1. Verify the work item ID exists in the project.
2. Verify you have access to the work item (check area path permissions).
3. Verify the correct project is targeted.

### Comments not loading

**Symptom:** Specs are generated but discussion context is missing (no
comments in the generated spec).

**Cause:** Comment fetching failed silently (see
[Why comment fetching is non-fatal](#why-comment-fetching-is-non-fatal)).

**Diagnosis:**

1. Test the comment command manually:
   ```bash
   az boards work-item relation list-comment \
     --work-item-id 100 \
     --org https://dev.azure.com/myorg \
     --project MyProject \
     --output json
   ```
2. Check that the `azure-devops` extension is up to date:
   `az extension update --name azure-devops`
3. Verify your account has permission to read work item comments.

### Permission denied (403)

**Symptom:** Error containing `TF401027` or `403`.

**Resolution:**

1. The authenticated user needs at least **Readers** access to the project.
2. Work items in restricted area paths may require additional permissions.
3. PATs need the **Work Items (Read)** scope at minimum.

## Related documentation

- [Overview](./overview.md) -- Architecture, data flow, and IssueDetails
  interface
- [GitHub Fetcher](./github-fetcher.md) -- The alternative fetcher for GitHub
  Issues
- [Integrations & Troubleshooting](./integrations.md) -- Subprocess behavior,
  timeouts, and error handling patterns
- [Adding a Fetcher](./adding-a-fetcher.md) -- Guide for implementing new
  tracker integrations
- [CLI argument parser](../cli-orchestration/cli.md) -- `--spec`, `--org`, and
  `--project` flag documentation

## External references

- [Azure DevOps CLI quickstart](https://learn.microsoft.com/en-us/azure/devops/cli/) --
  Installation and setup
- [`az boards work-item show`](https://learn.microsoft.com/en-us/cli/azure/boards/work-item?view=azure-cli-latest#az-boards-work-item-show) --
  Command reference
- [`az devops configure`](https://learn.microsoft.com/en-us/cli/azure/azure-cli-configuration) --
  Default organization and project configuration
- [Azure DevOps PAT scopes](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) --
  Token permission scopes
