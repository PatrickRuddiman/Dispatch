The spec file has been written to `.dispatch/specs/10-all-spec-generation-should-be-parallel.md`. Here's a summary of what the spec covers:

**Three main changes identified from the issue:**

1. **Parallelize spec generation** — Both the issue-fetching and spec-generation loops in `src/spec-generator.ts` are currently sequential `for` loops. The spec prescribes refactoring them to use the same batch-concurrent `Promise.all` pattern already established in `src/agents/orchestrator.ts`, reusing the existing `--concurrency` CLI flag.

2. **Push specs back to GitHub** — After generating each spec, update the originating issue's title and body on the tracker. This requires adding an `update()` method to the `IssueFetcher` interface and implementing it in both GitHub (`gh issue edit`) and Azure DevOps backends.

3. **Close issues upon task completion** — After all tasks from a spec are dispatched and completed, close the originating issue. This requires adding a `close()` method to the `IssueFetcher` interface and wiring it into the post-dispatch flow.

The spec contains 12 atomic, ordered tasks covering all three areas, with clear integration points and references to existing patterns in the codebase.