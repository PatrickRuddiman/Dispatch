# Add timer for spec generation to see each spec time and total time (#12)

> Add elapsed-time instrumentation to the spec-generation pipeline so operators can see how long each individual spec takes and the total pipeline duration.

## Context

Dispatch is a TypeScript CLI tool (Node.js >= 18, ESM-only) built with `tsup` and tested with Vitest. The relevant source lives under `src/`:

- **`src/spec-generator.ts`** — The core spec-generation pipeline. The `generateSpecs()` function orchestrates the full flow: parsing issue numbers, detecting the issue source, fetching issues in parallel batches, booting the AI provider, generating specs in parallel batches via `generateSingleSpec()`, and returning a `SpecSummary` object. This is the primary file that needs timing instrumentation.

- **`src/logger.ts`** — A minimal structured logger (`log`) using `chalk`. Provides `info`, `success`, `warn`, `error`, `debug`, `dim`, and `task` methods. All spec-generation progress is communicated through this logger. There are currently no timing-related methods or timestamp capabilities in the logger.

- **`src/tui.ts`** — The terminal UI used in dispatch mode (not spec mode). Contains an `elapsed(ms: number): string` helper function that formats milliseconds into human-readable strings like `"45s"` or `"2m 13s"`. This is the only existing duration-formatting logic in the codebase. The TUI also tracks `startTime` and per-task `elapsed` values using `Date.now()`.

- **`src/cli.ts`** — The CLI entry point. In spec mode, it calls `generateSpecs()` and exits based on the returned `SpecSummary`. The summary is currently only used for the exit code; all user-facing output happens inside `spec-generator.ts` via the logger.

- **`src/agents/orchestrator.ts`** — The dispatch-mode orchestrator. Already uses `Date.now()` start/end patterns for per-task timing, feeding elapsed values to the TUI. This establishes the project's timing idiom.

The `SpecSummary` interface (in `spec-generator.ts`) currently has four fields: `total`, `generated`, `failed`, and `files`. It does not include any timing data.

## Why

When generating specs — especially for multiple issues in parallel — there is currently no visibility into how long each step takes. Operators cannot tell whether slowness is caused by issue fetching, provider booting, or individual spec generation. Without timing data:

- It is impossible to identify bottlenecks in the pipeline.
- There is no feedback on whether concurrency settings are effective.
- Large batch runs provide no sense of progress duration or ETA.

Adding per-spec and total elapsed time addresses all of these and gives operators actionable performance data directly in the CLI output.

## Approach

Follow the existing timing idiom already established in the orchestrator and TUI: use `Date.now()` before and after each timed operation, compute the difference in milliseconds, and format using a shared duration-formatting helper.

**Key design decisions:**

1. **Extract the `elapsed()` formatter** from `tui.ts` into a shared location (either `logger.ts` or a small utility) so both the TUI and the spec generator can use the same formatting logic without duplication. Alternatively, re-implement the trivial function in `spec-generator.ts` if keeping modules decoupled is preferred — the function is only 6 lines.

2. **Instrument four timing points** inside `generateSpecs()`:
   - **Issue fetching phase** — time from start of all fetching to completion of all fetches.
   - **Provider boot** — time to boot the AI provider.
   - **Per-spec generation** — time each individual `generateSingleSpec()` call takes, logged alongside the existing success/failure message for that spec.
   - **Total pipeline** — wall-clock time from `generateSpecs()` entry to just before return.

3. **Log timing inline** with existing messages using `log.info()` and `log.success()`. For per-spec timings, append the duration to the existing `"Spec written: <path>"` success message (e.g., `"Spec written: <path> (42s)"`). For phase totals and overall total, add new summary log lines. This keeps the output consistent with the current style.

4. **Extend `SpecSummary`** to include timing data (e.g., `durationMs` for total, and optionally per-file timing) so callers have programmatic access. This is forward-looking and aligns with how the dispatch-mode summary works.

5. **No new CLI flags needed.** Timing should always be shown — it is lightweight metadata that aids debugging. Phase-level detail (fetch time, boot time) can be gated behind `log.debug()` if the output feels too noisy for non-verbose mode.

## Integration Points

- **`src/spec-generator.ts`** — Primary modification target. The `generateSpecs()` function, `generateSingleSpec()` function, and `SpecSummary` interface all need changes.

- **`src/logger.ts`** — If a shared `elapsed()` helper or a `log.timing()` method is added, it goes here. Otherwise the formatter can live in `spec-generator.ts` or a shared utility.

- **`src/tui.ts`** — Contains the existing `elapsed()` function. If extracted to a shared module, the TUI should import from the new location to avoid duplication.

- **`src/cli.ts`** — May optionally use new timing fields from `SpecSummary` for final summary output, but this is not required since `spec-generator.ts` already handles its own logging.

- **Existing patterns to match:**
  - `Date.now()` for timestamps (as in `orchestrator.ts`)
  - `elapsed(ms)` formatting as `"Ns"` or `"Nm Ns"` (as in `tui.ts`)
  - `log.info()` / `log.success()` / `log.debug()` for output (as in `spec-generator.ts`)
  - `chalk` for coloring if the timing text needs visual distinction

- **Build system:** `tsup` bundles from `src/cli.ts` — no config changes needed for new imports within `src/`.

- **Tests:** Vitest is the test runner. The `elapsed()` formatter should have unit tests if extracted to a shared module. `parser.test.ts` is the only existing test file and can serve as a convention reference.

## Tasks

- [ ] (S) Extract or create a shared `elapsed(ms: number): string` duration-formatting utility — move the existing `elapsed()` function from `tui.ts` into a shared location (e.g., a utility in `logger.ts` or a new small utility file) and update `tui.ts` to import from the new location. This avoids duplicating the formatting logic. If the team prefers keeping it duplicated for module independence, a simple inline helper in `spec-generator.ts` is acceptable.

- [ ] (S) Add timing instrumentation to `generateSpecs()` in `spec-generator.ts` — wrap the four phases (issue fetching, provider boot, spec generation per-issue, and total pipeline) with `Date.now()` start/end measurements. Log phase durations via `log.info()` or `log.debug()` using the shared `elapsed()` formatter. Append per-spec duration to the existing success log line for each spec. Add a total elapsed time to the final summary log line.

- [ ] (P) Extend the `SpecSummary` interface in `spec-generator.ts` to include timing data — add at minimum a `durationMs: number` field for total pipeline time. Optionally add per-file timing (e.g., a map of filepath to duration in ms) for programmatic consumers.

- [ ] (P) Add unit tests for the shared `elapsed()` formatter — test edge cases like 0ms, sub-second, exactly 60s, and multi-minute durations. Follow the conventions in the existing `parser.test.ts` (Vitest, `.test.ts` suffix, colocated with source).

## References

- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/12
- Existing timing pattern: `src/agents/orchestrator.ts` (per-task `Date.now()` usage)
- Existing duration formatter: `src/tui.ts` (`elapsed()` function)
- Logger module: `src/logger.ts`
