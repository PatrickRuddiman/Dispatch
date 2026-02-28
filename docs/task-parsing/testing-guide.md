# Testing Guide

This document explains how to run the parser tests, what the test suite covers,
and how to extend it.

## Running tests

### All tests

```bash
npm test
```

This runs `vitest run`, which executes all test files in the project in
non-watch mode.

### Parser tests in isolation

```bash
npx vitest run src/tests/parser.test.ts
```

Or in watch mode for development:

```bash
npx vitest src/tests/parser.test.ts
```

### Test runner configuration

The project uses [Vitest](https://vitest.dev/) (v4.x) as its test framework.
There is no `vitest.config.ts` file in the project root -- Vitest uses its
default configuration, which automatically discovers `*.test.ts` files and
uses the project's `tsconfig.json` for TypeScript support.

The `package.json` defines two test scripts:

| Script | Command | Behavior |
|---|---|---|
| `test` | `vitest run` | Single run, exits with code |
| `test:watch` | `vitest` | Watch mode, re-runs on change |

## Test suite structure

The test file (`src/tests/parser.test.ts`) is organized into five `describe` blocks
covering each public function:

### parseTaskContent (pure, no I/O)

These tests validate the core parsing logic using in-memory strings. No file
system access is involved.

| Test | What it verifies |
|---|---|
| extracts basic dash tasks | Standard `- [ ]` syntax with dash markers |
| extracts asterisk tasks | `* [ ]` syntax with asterisk markers |
| handles indented tasks | Space-indented nested lists (2, 4, 6 spaces) |
| handles tab-indented tasks | Tab-indented nested lists |
| skips already-checked tasks | `[x]` and `[X]` are excluded from results |
| handles mixed task and non-task content | Headings, prose, blank lines mixed with tasks |
| preserves full file content | `TaskFile.content` equals the input string |
| returns correct line numbers with blank lines | Line numbers account for blank lines |
| returns empty tasks for no checkboxes | Files with regular lists but no checkboxes |
| returns empty tasks for empty file | Edge case: empty string input |
| handles tasks with inline markdown formatting | Bold, code, links, italic in task text |
| handles tasks with special characters | Regex special chars, `$`, parentheses |
| does not match lines without proper checkbox syntax | **Negative tests** for invalid formats |
| assigns sequential zero-based indices | Index field increments correctly |
| preserves the raw line including indentation | `raw` field captures full original line |
| handles a realistic multi-section task file | Integration test with 7 tasks across 3 phases |
| handles single-task file | Edge case: one task only |
| handles trailing newline | Trailing `\n` does not create phantom tasks |
| handles Windows-style CRLF line endings | CRLF normalization produces clean text |

### parseTaskFile (with file I/O)

These tests create temporary files on disk and verify the full read-parse
pipeline.

| Test | What it verifies |
|---|---|
| reads and parses a file from disk | End-to-end file reading and parsing |

### markTaskComplete

These tests create temporary files on disk, mark tasks complete, and verify the
file contents afterward.

| Test | What it verifies |
|---|---|
| replaces `[ ]` with `[x]` at the correct line | Basic mark-complete behavior |
| preserves indentation when marking complete | Indented tasks stay indented |
| throws on out-of-range line number | Error when `task.line` exceeds file length |
| throws if the line no longer matches unchecked pattern | Error when line is already checked or modified |

### buildTaskContext

These tests verify the filtering logic that produces planner-ready context.

| Test | What it verifies |
|---|---|
| keeps the current task and removes other unchecked tasks | Core filtering behavior |
| preserves all non-task content | Headings, prose, blank lines survive filtering |
| preserves checked tasks | Completed tasks are context, not removed |
| works when the file has only one unchecked task | Edge case: single task = no filtering |
| handles indented sibling tasks | Nested unchecked tasks are also stripped |
| handles CRLF line endings | CRLF normalization in filtering |
| preserves asterisk tasks of other types | Non-checkbox `*` list items survive |
| produces a realistic filtered context | Integration test with multi-section file |

### groupTasksByMode

These tests verify the execution group partitioning logic.

| Test | What it verifies |
|---|---|
| returns empty array for empty input | Edge case: empty input |
| groups a lone serial task as a solo group | Single serial task |
| groups a lone parallel task as a solo group | Single parallel task |
| accumulates consecutive parallel tasks into one group | `[P,P,P]` → `[[P,P,P]]` |
| serial task caps the current group | `[P,S]` → `[[P,S]]` |
| correct groups for P S S P P P pattern | Mixed grouping |
| all-serial tasks as individual solo groups | `[S,S,S]` → `[[S],[S],[S]]` |
| treats undefined mode as serial | Default mode behavior |
| preserves task order within groups | Index ordering |
| handles serial at start followed by parallel | `[S,P,P]` → `[[S],[P,P]]` |

For the detailed grouping algorithm and examples, see
[Parser Tests (detailed)](../testing/parser-tests.md#grouptasksbymode-10-tests).

## Temporary file cleanup

Tests that perform file I/O use the following pattern for cleanup:

```typescript
let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

it("test name", async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
  // ... test body
});
```

Each I/O test creates a unique temporary directory under the OS temp directory
(e.g., `/tmp/dispatch-test-abc123`). The `afterEach` hook removes this directory
after each test, even if the test fails.

**What if a test fails midway?** The `afterEach` hook runs regardless of test
success or failure, so temporary directories are cleaned up even when assertions
throw. The only scenario where cleanup would be skipped is if the test process
is killed (e.g., `SIGKILL`), in which case orphaned `/tmp/dispatch-test-*`
directories may remain. These can be manually removed or will be cleaned up by
the OS's periodic `/tmp` purge.

## Adding new tests

When adding tests for the parser:

1. **Pure logic tests** go in the `parseTaskContent` describe block. Use
   in-memory strings -- no file I/O needed.
2. **File I/O tests** go in the `parseTaskFile` or `markTaskComplete` blocks.
   Follow the `mkdtemp`/`afterEach` cleanup pattern.
3. **Context filtering tests** go in the `buildTaskContext` block.
4. **Grouping logic tests** go in the `groupTasksByMode` block.
5. **Negative tests** (invalid syntax that should NOT match) are important for
   documenting the parser's rejection criteria. Add them to the `parseTaskContent`
   block.

## Related documentation

- [Overview](./overview.md) -- what the parser does and why
- [Markdown Syntax Reference](./markdown-syntax.md) -- accepted and rejected
  formats (tested by the negative test cases)
- [API Reference](./api-reference.md) -- function contracts that the tests verify
- [Architecture & Concurrency](./architecture-and-concurrency.md) -- concurrency
  concerns and the read-modify-write pattern tested by `markTaskComplete` tests

### Project-wide test documentation

This page covers only the parser tests. For documentation of the full test
suite -- including configuration, formatting, and spec generator tests -- see
the [Testing section](../testing/overview.md):

- [Test suite overview](../testing/overview.md) -- framework, patterns, and
  coverage map for all test files
- [Parser tests (detailed)](../testing/parser-tests.md) -- comprehensive
  breakdown of all 62 parser tests including mode extraction and grouping
- [Configuration tests](../testing/config-tests.md) -- config I/O, validation,
  merge precedence, and `handleConfigCommand` tests
- [Format utility tests](../testing/format-tests.md) -- `elapsed()` duration
  formatting tests
- [Spec generator tests](../testing/spec-generator-tests.md) -- spec pipeline
  input classification, prompt construction, validation, and content extraction
