# Type Guards

The guards module provides runtime type-checking utilities that work with
TypeScript's type narrowing system. Currently it exports a single function,
`hasProperty`, which safely checks whether an unknown value has a given
property.

**Source file:** [`src/helpers/guards.ts`](../../src/helpers/guards.ts) (28 lines)

## What it does

### `hasProperty(value, key)`

```ts
function hasProperty<K extends string>(
    value: unknown,
    key: K,
): value is Record<K, unknown>
```

Given an `unknown` value and a string key, `hasProperty` returns `true` if:

1.  The value is a non-null object (or function).
2.  The object has the specified key as its **own** property (not inherited
    from the prototype chain).

When the function returns `true`, TypeScript narrows the type of `value` from
`unknown` to `Record<K, unknown>`, allowing the caller to safely access
`value[key]` without a type assertion.

## Why it exists

Dispatch processes loosely-typed data from external sources -- SSE event
payloads from AI providers, parsed JSON responses, and dynamically shaped
configuration objects. These values arrive as `unknown` and must be inspected
at runtime before access.

TypeScript offers several ways to check for properties on unknown values, but
each has drawbacks that `hasProperty` avoids:

### Why not `as` type assertions?

Type assertions (`value as SomeType`) bypass runtime checks entirely.
They tell the compiler "trust me," but if the value doesn't actually match,
the code fails at runtime with no guard against the mismatch. This is
unsafe for external data where the shape is not guaranteed.

### Why not the `in` operator?

The `in` operator (`"key" in value`) requires the value to already be typed
as `object` -- it cannot be used directly on `unknown`. Code using `in` must
first narrow via `typeof value === "object" && value !== null`, adding
boilerplate to every check site. Additionally, `in` checks the entire
prototype chain, which can produce unexpected `true` results for inherited
properties like `toString` or `constructor`.

### Why `hasProperty` is preferred

-   **Works on `unknown`:** No prerequisite narrowing needed. Pass any value
    directly.
-   **Own-property only:** Uses `Object.prototype.hasOwnProperty.call()`
    internally, checking only the object's own properties and ignoring the
    prototype chain.
-   **Type predicate return:** The `value is Record<K, unknown>` return type
    integrates with TypeScript's control flow analysis. After a truthy check,
    the compiler knows `value[key]` exists and is `unknown` (not `any`).
-   **Composable:** Multiple `hasProperty` calls can be chained to
    progressively narrow deeply nested structures.

## How TypeScript type narrowing works with `hasProperty`

The function signature uses a [type predicate](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates)
(`value is Record<K, unknown>`). When `hasProperty` returns `true` inside a
conditional, TypeScript's control flow analysis narrows the type of the
checked variable for the duration of that branch:

```ts
const data: unknown = getEventPayload();

// Before: data is `unknown` — no property access allowed
if (hasProperty(data, "sessionID")) {
    // After: data is `Record<"sessionID", unknown>`
    // data.sessionID is safely accessible as `unknown`
    const id = data.sessionID;
}
```

Chaining multiple checks narrows the type further:

```ts
if (hasProperty(data, "info") && hasProperty(data.info, "sessionID")) {
    // data is Record<"info", unknown>
    // data.info is Record<"sessionID", unknown>
    const id = data.info.sessionID; // safe
}
```

This is exactly how the function is used in the OpenCode provider
(`src/providers/opencode.ts:274-287`) to filter SSE events by session ID
across three different nesting patterns (`props.sessionID`,
`props.info.sessionID`, `props.part.sessionID`).

## Where it is used

The primary consumer is the OpenCode provider (`src/providers/opencode.ts`):

| Location | Purpose |
|----------|---------|
| `opencode.ts:232` | Check if an assistant message has an `error` field |
| `opencode.ts:274` | Filter SSE events: check for `sessionID`, `info`, or `part` on event properties |
| `opencode.ts:279` | Read `props.sessionID` for direct session matching |
| `opencode.ts:282` | Read `props.info.sessionID` for nested session matching |
| `opencode.ts:287` | Read `props.part.sessionID` for deeply nested session matching |

All of these use cases involve narrowing `unknown` SSE event payloads from
an external process -- exactly the scenario where runtime type guards are
essential.

## Cross-group dependencies

-   **Provider system:** The OpenCode provider
    (`src/providers/opencode.ts`) is the primary consumer of `hasProperty`.
-   **Helpers barrel:** Re-exported from `src/helpers/index.ts` so any module
    can import it via `"../helpers/guards.js"` or `"../helpers/index.js"`.

## Related documentation

-   [Shared Utilities overview](./overview.md) -- Context for the shared
    utilities group and the helpers barrel.
-   [Errors](./errors.md) -- The `UnsupportedOperationError` class, another
    shared utility for runtime safety.
-   [Provider System overview](../provider-system/overview.md) -- The
    provider subsystem where `hasProperty` is used for SSE event parsing.
-   [OpenCode Backend](../provider-system/opencode-backend.md) -- The specific
    provider implementation that uses `hasProperty` for SSE event filtering.
-   [Provider Tests](../testing/provider-tests.md) -- Unit tests that verify
    the SSE event filtering behavior powered by `hasProperty`.
