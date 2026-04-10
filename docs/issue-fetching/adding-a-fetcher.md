# Adding a Fetcher

> **Deprecated.** The `IssueFetcher` interface and the `src/issue-fetchers/`
> registry described below are deprecated compatibility shims. New integrations
> should implement the [`Datasource`](../datasource-system/overview.md) interface in `src/datasource.ts` and
> register in `src/datasources/index.ts`. The `Datasource` interface is a
> superset of `IssueFetcher`, adding `list()` and `create()` methods.
> See the [Deprecated Compatibility Layer](../deprecated-compat/overview.md)
> for the full interface comparison and migration guide.

This guide walks through the steps required to add a new issue tracker
integration (e.g., Jira, Linear, GitLab) to the issue fetching subsystem.

## Overview

The issue fetching system uses a strategy pattern: each tracker has a fetcher
module that implements the `IssueFetcher` interface and is registered in a
central map. Adding a new tracker requires changes in three files and
optionally a fourth for auto-detection.

> **Note:** The instructions below reference the deprecated `IssueFetcher` path.
> For new implementations, create a datasource module in `src/datasources/`
> implementing the [`Datasource`](../datasource-system/overview.md) interface from `src/datasource.ts`, and register
> it in the `DATASOURCES` map in `src/datasources/index.ts`. The deprecated
> shim layer will automatically pick up any new datasource whose name is in the
> `IssueSourceName` type (i.e., excludes `"md"`).

## Step-by-step checklist

### 1. Add the source name to the IssueSourceName union

**File:** `src/issue-fetcher.ts:15`

Add the new name to the `IssueSourceName` string literal union:

```typescript
// Before
export type IssueSourceName = "github" | "azdevops";

// After
export type IssueSourceName = "github" | "azdevops" | "jira";
```

This change gives compile-time type safety -- TypeScript will flag any
`Record<IssueSourceName, ...>` or `switch` statement that does not cover the
new name.

### 2. Create the fetcher module

**File:** `src/issue-fetchers/<name>.ts`

Create a new file that exports a `fetcher` object satisfying the `IssueFetcher`
interface:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  IssueFetcher,
  IssueDetails,
  IssueFetchOptions,
} from "../issue-fetcher.js";

const exec = promisify(execFile);

export const fetcher: IssueFetcher = {
  name: "jira",

  async fetch(
    issueId: string,
    opts: IssueFetchOptions = {}
  ): Promise<IssueDetails> {
    // Shell out to the tracker's CLI tool, or use an HTTP client
    // Parse the response and return normalized IssueDetails
    return {
      number: issueId,
      title: "",
      body: "",
      labels: [],
      state: "",
      url: "",
      comments: [],
      acceptanceCriteria: "",
    };
  },
};
```

**Key decisions when implementing a fetcher:**

- **CLI vs HTTP:** The existing fetchers shell out to CLI tools (`gh`, `az`)
  for authentication simplicity. You may also use HTTP APIs directly if
  preferred -- the interface does not mandate the implementation strategy.
- **Error handling:** The main `fetch()` method should let errors propagate.
  The [spec generator](../spec-generation/overview.md) handles per-issue failures. Optional data (like comments)
  can be fetched in a try/catch that returns defaults on failure.
- **Field mapping:** Map the tracker's native fields to [`IssueDetails`](./overview.md#issuedetails-interface).
  Fields that have no equivalent should use sensible defaults (empty string
  for `acceptanceCriteria`, empty array for `labels`).
- **HTML vs markdown:** Document whether the `body` field contains HTML or
  markdown. The spec generator passes it to the AI as-is.

### 3. Register the fetcher

**File:** `src/issue-fetchers/index.ts`

Import the new fetcher and add it to the `FETCHERS` map:

```typescript
import { fetcher as jiraFetcher } from "./jira.js";

const FETCHERS: Record<IssueSourceName, IssueFetcher> = {
  github: githubFetcher,
  azdevops: azdevopsFetcher,
  jira: jiraFetcher,  // new
};
```

Because `FETCHERS` is typed as `Record<IssueSourceName, IssueFetcher>`,
TypeScript will produce a compile error if the new source name is in the
union but missing from the map (or vice versa). This ensures the type and
registry stay in sync.

### 4. (Optional) Add auto-detection pattern

**File:** `src/issue-fetchers/index.ts:52-56`

If the new tracker can be detected from a git remote URL, add a pattern to
the `SOURCE_PATTERNS` array:

```typescript
const SOURCE_PATTERNS: { pattern: RegExp; source: IssueSourceName }[] = [
  { pattern: /github\.com/i, source: "github" },
  { pattern: /dev\.azure\.com/i, source: "azdevops" },
  { pattern: /visualstudio\.com/i, source: "azdevops" },
  { pattern: /gitlab\.com/i, source: "gitlab" },  // new
];
```

**Pattern ordering matters.** The `SOURCE_PATTERNS` array uses first-match-wins
semantics. Place more specific patterns before less specific ones. If a URL
could match multiple patterns, the first match determines the detected source.

If auto-detection is not possible (e.g., Jira does not use git remotes),
skip this step. Users will need to specify `--source jira` explicitly.

### 5. Add IssueFetchOptions fields (if needed)

**File:** `src/issue-fetcher.ts:42-49`

If the new tracker requires additional options beyond `cwd`, `org`, and
`project`, add them to the `IssueFetchOptions` interface. Then update the
CLI parser in `src/cli.ts` to accept the new flags.

For example, if the tracker needs an API token passed explicitly:

```typescript
export interface IssueFetchOptions {
  cwd?: string;
  org?: string;
  project?: string;
  apiToken?: string;  // new
}
```

### 6. Update documentation

After implementing the fetcher:

1. Add a documentation page in `docs/issue-fetching/<name>-fetcher.md`
   following the structure of the existing
   [GitHub Fetcher](./github-fetcher.md) and
   [Azure DevOps Fetcher](./azdevops-fetcher.md) pages.
2. Add the new page to the component index in
   [Overview](./overview.md#component-index).
3. Update the [architecture diagram](./overview.md#architecture) to include
   the new fetcher.

## Compile-time safety

The combination of the `IssueSourceName` union type and the
`Record<IssueSourceName, IssueFetcher>` type for the `FETCHERS` map provides
compile-time guarantees:

- **Missing fetcher:** If you add a name to `IssueSourceName` but forget to
  add it to `FETCHERS`, TypeScript reports: `Property 'jira' is missing`.
- **Unknown fetcher:** If you add to `FETCHERS` without updating
  `IssueSourceName`, the key does not satisfy the `Record` type.
- **CLI validation:** `ISSUE_SOURCE_NAMES` (derived from `Object.keys(FETCHERS)`)
  automatically includes the new name, so `--source` validation and help text
  update without additional changes.

## Why IssueSourceName is not derived from the registry

The `IssueSourceName` type could theoretically be derived from the `FETCHERS`
registry keys:

```typescript
const FETCHERS = { github: ..., azdevops: ..., jira: ... } as const;
type IssueSourceName = keyof typeof FETCHERS;
```

This would eliminate the manual sync step. However, `IssueSourceName` is
defined in `src/issue-fetcher.ts` (the interface file), while `FETCHERS` is
defined in `src/issue-fetchers/index.ts` (the implementation file). Deriving
the type from the implementation would create a circular dependency or require
restructuring the module layout. The current design keeps the interface file
free of implementation imports at the cost of manual synchronization.

## Related documentation

- [Overview](./overview.md) -- Architecture and the IssueDetails interface
- [GitHub Fetcher](./github-fetcher.md) -- Reference implementation using
  a CLI tool
- [Azure DevOps Fetcher](./azdevops-fetcher.md) -- Reference implementation
  with optional comment fetching
- [Datasource System Overview](../datasource-system/overview.md) -- The newer
  `Datasource` interface that supersedes `IssueFetcher`
- [Deprecated Compatibility Layer](../deprecated-compat/overview.md) -- Migration
  guide from `IssueFetcher` to `Datasource`
- [Integrations](../datasource-system/integrations.md) -- Subprocess patterns and error handling
- [Adding a Provider](../provider-system/adding-a-provider.md) -- Analogous
  guide for the AI provider abstraction layer
- [Spec Generation](../spec-generation/overview.md) -- The pipeline that
  consumes fetched issue data
- [Prerequisites — External Integrations](../prereqs-and-safety/integrations.md) --
  How CLI tools (`gh`, `az`) are detected at startup; new fetcher CLI
  dependencies should follow the same `execFile("tool", ["--version"])` pattern
- [Provider Binary Detection](../prereqs-and-safety/provider-detection.md) --
  Similar binary detection pattern used for AI provider tools
- [Testing Overview](../testing/overview.md) -- Project-wide test framework;
  new fetchers should include tests following existing patterns
- [Datasource Testing](../datasource-system/testing.md) -- Test coverage
  for the datasource implementations that new fetchers should follow
