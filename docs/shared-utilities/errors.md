# UnsupportedOperationError

`UnsupportedOperationError` is a custom error class that signals when a
datasource implementation does not support a particular interface operation.
It extends the built-in `Error` class with an `operation` property that
identifies which method was called.

**Source file:** [`src/helpers/errors.ts`](../../src/helpers/errors.ts) (19 lines)

## What it does

The class extends `Error` and adds a single read-only property:

| Property | Type | Description |
|----------|------|-------------|
| `operation` | `string` | The name of the unsupported method (e.g., `"createAndSwitchBranch"`) |
| `name` | `string` | Always `"UnsupportedOperationError"` (overrides `Error.name`) |
| `message` | `string` | Auto-generated: `"Operation not supported: <operation>"` |

The constructor accepts one argument -- the operation name -- and builds the
message string automatically.

## Why it exists

The [Datasource interface](../datasource-system/overview.md) defines a
uniform contract covering CRUD operations, git lifecycle methods, and pull
request creation. Not every datasource backend supports every operation. The
[markdown datasource](../datasource-system/markdown-datasource.md) operates
on local files and has no concept of git branches or pull requests, yet it
must implement the full `Datasource` interface.

Rather than returning `null` or silently doing nothing, the markdown
datasource throws `UnsupportedOperationError` for every git lifecycle method.
This makes unsupported operations **loud and unambiguous** -- callers learn
immediately that the operation is structurally impossible, not that it failed
due to a transient error.

## How it differs from a plain Error

A plain `Error` conveys that something went wrong. `UnsupportedOperationError`
conveys that the operation **cannot succeed** regardless of retries or
configuration changes -- it is a structural limitation of the datasource.

Key differences:

-   **The `operation` property** lets catch blocks inspect which method was
    called without parsing the message string.
-   **The `name` property** is set to `"UnsupportedOperationError"` (not
    `"Error"`), enabling `instanceof` checks and clear identification in stack
    traces and logs.
-   **Semantic meaning:** catching this error should not trigger retry logic.
    The correct response is to skip the operation or select a different
    datasource that supports it.

## When it is thrown

The markdown datasource (`src/datasources/md.ts`) throws this error for all
five git lifecycle methods:

| Method | Source location |
|--------|----------------|
| `createAndSwitchBranch()` | `src/datasources/md.ts:165` |
| `switchBranch()` | `src/datasources/md.ts:169` |
| `pushBranch()` | `src/datasources/md.ts:173` |
| `commitAllChanges()` | `src/datasources/md.ts:177` |
| `createPullRequest()` | `src/datasources/md.ts:187` |

No other module in the codebase currently throws this error.

## How to catch it

Use `instanceof` to distinguish unsupported operations from general errors:

```ts
import { UnsupportedOperationError } from "../helpers/errors.js";

try {
    await datasource.createAndSwitchBranch(branchName, opts);
} catch (err) {
    if (err instanceof UnsupportedOperationError) {
        // Structural limitation -- skip this step
        log.info(`Skipping ${err.operation}: not supported by this datasource`);
    } else {
        // Unexpected failure -- propagate
        throw err;
    }
}
```

The test suites at `src/tests/md-datasource.test.ts` (see
[Datasource Testing](../datasource-system/testing.md)) and
`src/tests/git.test.ts` demonstrate the expected catch pattern using Vitest's
`rejects.toThrow(UnsupportedOperationError)` matcher.

## Cross-group dependencies

-   **Datasource system:** The markdown datasource
    (`src/datasources/md.ts`) is the sole producer of this error.
-   **Helpers barrel:** Re-exported from `src/helpers/index.ts` so any module
    can import it via `"../helpers/errors.js"` or `"../helpers/index.js"`.

## Related documentation

-   [Shared Utilities overview](./overview.md) -- Context for the shared
    utilities group and the helpers barrel.
-   [Guards](./guards.md) -- The `hasProperty` type guard, another shared
    utility for runtime type safety.
-   [Markdown Datasource](../datasource-system/markdown-datasource.md) --
    The datasource that throws this error for git lifecycle methods.
-   [Datasource System overview](../datasource-system/overview.md) -- The
    interface contract that drives the need for this error class.
-   [Architecture overview](../architecture.md) -- System-wide context.
-   [Datasource Testing](../datasource-system/testing.md) -- Tests that
    verify `UnsupportedOperationError` is thrown by the markdown datasource.
-   [Shared Utilities Testing](./testing.md) -- Testing overview for the
    shared utility modules (note: `errors.ts` is tested indirectly via
    datasource tests).
