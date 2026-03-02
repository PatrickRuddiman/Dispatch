# Slugify

## What it does

The `slugify` function in
[`src/slugify.ts`](../../src/slugify.ts) converts an arbitrary input string
into a lowercase, hyphen-separated identifier containing only ASCII letters
and digits. It accepts an optional `maxLength` parameter to truncate the
result.

The transformation pipeline is:

1. **Lowercase** the entire input.
2. **Strip** every character that is not `a-z` or `0-9` by replacing
   sequences of such characters with a single hyphen.
3. **Trim** leading and trailing hyphens.
4. **Truncate** to `maxLength` characters via `.slice(0, maxLength)` if
   the parameter is provided.

The function is pure, has no dependencies, and is safe to call in any
context.

## Why it exists

Dispatch generates two kinds of identifiers from user-supplied issue titles:

- **Git branch names** in the pattern `dispatch/<number>-<slug>`, used by
  the [GitHub](../datasource-system/github-datasource.md), [Azure DevOps](../datasource-system/azdevops-datasource.md), and [markdown](../datasource-system/markdown-datasource.md) datasources.
- **Spec filenames** in the pattern `<id>-<slug>.md`, used by the [spec
  pipeline](../spec-generation/overview.md) and [datasource helpers](../datasource-system/datasource-helpers.md).

Both contexts require identifiers that are portable across operating systems,
Git hosts, and filesystem conventions. `slugify` guarantees this by producing
only `[a-z0-9-]` output.

## How it is used across the codebase

| Call site | maxLength | Purpose |
|-----------|-----------|---------|
| [`src/datasources/github.ts:33`](../../src/datasources/github.ts) | 50 | Branch name slug |
| [`src/datasources/azdevops.ts:195`](../../src/datasources/azdevops.ts) | 50 | Branch name slug |
| [`src/datasources/md.ts:140`](../../src/datasources/md.ts) | 50 | Branch name slug |
| [`src/datasources/md.ts:129`](../../src/datasources/md.ts) | *(none)* | Internal identifier in `create()` |
| [`src/orchestrator/spec-pipeline.ts:103`](../../src/orchestrator/spec-pipeline.ts) | 60 | Spec filename slug |
| [`src/orchestrator/spec-pipeline.ts:208`](../../src/orchestrator/spec-pipeline.ts) | 60 | Spec filename slug |
| [`src/orchestrator/spec-pipeline.ts:237`](../../src/orchestrator/spec-pipeline.ts) | 60 | Spec filename slug |
| [`src/orchestrator/datasource-helpers.ts:71`](../../src/orchestrator/datasource-helpers.ts) | 60 | Spec filename slug |

### maxLength conventions

| Limit | Context | Rationale |
|-------|---------|-----------|
| 50 | Branch names | Practical portability limit across Git hosts and CLI tools |
| 60 | Spec filenames | Accommodates longer titles while keeping filenames readable |

## Unicode handling

The regex `/[^a-z0-9]+/g` operates on the lowercased string and strips every
character outside the ASCII `a-z` and `0-9` ranges. This means:

- **Accented Latin characters** are stripped, not transliterated. For example,
  `"cafe resume"` with accents becomes `"caf-r-sum"` because `e`, `e`, and
  `e` with diacritics are outside `a-z`.
- **CJK, Cyrillic, Arabic**, and other non-Latin scripts produce empty
  segments, collapsing to hyphens or empty strings.
- **Emoji** and other symbols are also stripped entirely.

This is a deliberate design choice that keeps the implementation simple and
dependency-free at the cost of lossy conversion for non-ASCII input. A
transliteration library (e.g., `transliteration` or `slugify` from npm)
would preserve more information but add a runtime dependency.

## Truncation edge case

The `maxLength` truncation applies **after** the leading/trailing hyphen
trim but the trim does **not** run again after truncation. This means
`.slice(0, maxLength)` can produce a result ending with a hyphen if the
truncation point lands immediately after a replaced character sequence.

For example, an input that produces `"hello-world"` truncated to 6
characters yields `"hello-"`. The test suite does not currently cover this
specific edge case. In practice the impact is cosmetic -- a trailing hyphen
in a branch name or filename is valid and does not cause functional issues.

## Test coverage

The test file
[`src/tests/slugify.test.ts`](../../src/tests/slugify.test.ts)
contains 24 tests organized across multiple `describe` blocks covering:

- Basic transformations (spaces, uppercase, special characters, multiple
  spaces, leading/trailing whitespace)
- Unicode input (accented characters, CJK, mixed scripts)
- Truncation behavior (mid-word, exact boundary, maxLength of 0 and 1)
- Already-valid input (no-op passthrough)
- Empty and whitespace-only input
- Real-world patterns with maxLength 50 and 60

See [Testing](./testing.md) for instructions on running these tests.

## Related documentation

- [Shared Utilities overview](./overview.md) -- Context for both shared
  utility modules
- [Timeout](./timeout.md) -- The other shared utility module
- [Testing](./testing.md) -- How to run slugify and timeout tests
- [Shared Interfaces & Utilities](../shared-types/overview.md) -- The shared
  layer that depends on slugify
- [GitHub Datasource](../datasource-system/github-datasource.md) -- Uses
  `slugify(title, 50)` for branch name generation
- [Datasource System](../datasource-system/overview.md) -- Datasources that
  consume slugify for branch names
- [Spec Generation](../spec-generation/overview.md) -- Spec pipelines that
  consume slugify for filenames
- [Testing Overview](../testing/overview.md) -- Project-wide test suite
  including slugify tests
