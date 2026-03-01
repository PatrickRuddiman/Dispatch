# Markdown Syntax Reference

This document specifies exactly which markdown checkbox syntax variants the
parser accepts and rejects, and explains the regex patterns that enforce these
rules.

## Supported syntax

The parser recognizes GitHub Flavored Markdown (GFM) task list items. A valid
unchecked task line must match this exact pattern (see also the
[Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md#markdown-task-file-format)
for recommended task file structure):

```
<optional whitespace><dash or asterisk><space>[ ]<space><task text>
```

### Regex definitions

The parser uses two regular expressions defined in `src/parser.ts:31-33`:

```
UNCHECKED_RE = /^(\s*[-*]\s)\[ \]\s+(.+)$/
CHECKED_RE   = /^(\s*[-*]\s)\[[xX]\]\s+/
CHECKED_SUB  = "$1[x] $2"
```

### Accepted formats

| Format | Example | Notes |
|---|---|---|
| Dash list marker | `- [ ] Task text` | Most common format |
| Asterisk list marker | `* [ ] Task text` | Also valid per GFM |
| Space-indented | `  - [ ] Nested task` | Any amount of leading whitespace |
| Tab-indented | `\t- [ ] Nested task` | Tabs count as whitespace |
| Deeply nested | `      - [ ] Deep task` | Arbitrary indent depth |
| Inline formatting | `- [ ] Use **bold** and \`code\`` | Text after checkbox is captured as-is |
| Special characters | `- [ ] Fix the \`user?.name ?? 'default'\`` | Regex `.+` captures everything |
| Checked (lowercase) | `- [x] Done task` | Recognized by `CHECKED_RE`, skipped by parser |
| Checked (uppercase) | `- [X] Done task` | Also recognized by `CHECKED_RE` |

### Rejected formats

The following are intentionally **not** recognized as task items. These are
verified by the negative test cases in `src/parser.test.ts:182-196`:

| Format | Example | Why rejected |
|---|---|---|
| Missing space in checkbox | `- [] Task` | Must be `[ ]` with exactly one space |
| Missing space after marker | `-[ ] Task` | Requires `\s` between `-` and `[` |
| Extra space in checkbox | `- [  ] Task` | Only single space accepted inside brackets |
| No list marker | `[ ] Task` | Must start with `-` or `*` list marker |
| Indented without marker | `  [ ] Task` | Whitespace alone does not create a list item |
| No space after checkbox | `- [ ]Task` | Requires `\s+` between `]` and text |
| Empty task text | `- [ ] ` | The `.+` requires at least one character |

## Parallel and serial mode prefixes

Tasks can be annotated with a `(P)` or `(S)` prefix to control whether they
execute in parallel or serial within the dispatch pipeline. This prefix appears
immediately after the checkbox and before the task description.

### Regex definition

The mode prefix is parsed by `MODE_PREFIX_RE` defined at `src/parser.ts:36`:

```
MODE_PREFIX_RE = /^\(([PS])\)\s+/
```

This regex is applied to the **extracted task text** (group 2 of `UNCHECKED_RE`)
after trimming, not to the raw line. It matches a literal `(`, a single letter
`P` or `S`, a literal `)`, followed by one or more spaces.

### Syntax

| Format | Example | Resulting `mode` | Resulting `text` |
|---|---|---|---|
| Parallel prefix | `- [ ] (P) Run tests` | `"parallel"` | `"Run tests"` |
| Serial prefix | `- [ ] (S) Deploy to staging` | `"serial"` | `"Deploy to staging"` |
| No prefix | `- [ ] Fix the login bug` | `"serial"` (default) | `"Fix the login bug"` |
| Lowercase (not matched) | `- [ ] (p) Run tests` | `"serial"` (default) | `"(p) Run tests"` |

**Key behaviors:**

- The prefix is **case-sensitive**: only uppercase `(P)` and `(S)` are
  recognized. Lowercase `(p)` or `(s)` is treated as part of the task text.
- The prefix is **stripped** from the `text` field. The stored `text` does not
  include `(P)` or `(S)`.
- When no prefix is present, the task defaults to `mode: "serial"`.
- A space is required between the closing `)` and the task description.

### How mode prefixes affect execution

The `mode` field drives the
[`groupTasksByMode()`](./api-reference.md#grouptasksbymode) algorithm, which
groups consecutive tasks into execution batches:

- **Parallel** (`(P)`) tasks accumulate in the current group. They can run
  concurrently with other tasks in the same group (up to `--concurrency`).
- **Serial** (`(S)` or no prefix) tasks cap the current group and start a new
  one. The orchestrator waits for the entire group to complete before starting
  the next group.

### Example task file with mode prefixes

```markdown
# Build Pipeline Tasks

- [ ] (P) Run unit tests
- [ ] (P) Run integration tests
- [ ] (P) Run linting checks
- [ ] (S) Merge results and generate report
- [ ] (P) Deploy to staging
- [ ] (P) Run smoke tests
- [ ] Notify team on Slack
```

This produces three execution groups:

1. **Group 1** (4 tasks): Run unit tests, Run integration tests, Run linting
   checks, Merge results and generate report -- the first three run in parallel
   (up to `--concurrency`), the serial task caps the group.
2. **Group 2** (2 tasks): Deploy to staging, Run smoke tests -- both run in
   parallel within the group.
3. **Group 3** (1 task): Notify team on Slack -- serial, runs alone since the
   trailing parallel tasks in group 2 were flushed, and this task (with no
   prefix, defaulting to serial) forms its own group.

See [Orchestrator — Concurrency Model](../cli-orchestration/orchestrator.md#concurrency-model)
for how the orchestrator processes these groups.

## How the CHECKED_SUB replacement works

When `markTaskComplete` converts a task, it uses `String.replace` with the
`UNCHECKED_RE` regex and the `CHECKED_SUB` template:

```
original:  "  - [ ] Some task"
           ^^^^^^^^^^^^^^^^^^^
           $1 = "  - "    (captured by first group: \s*[-*]\s)
           $2 = "Some task"  (captured by second group: .+)

result:    "  - [x] Some task"
           $1 + "[x] " + $2
```

The backreference `$1` preserves whatever whitespace prefix and list marker
style was used in the original line. This means:

- Dash markers stay as dashes
- Asterisk markers stay as asterisks
- Indentation is preserved exactly

This is confirmed by the test at `src/parser.test.ts:371-389` which verifies
that `"    - [ ] Indented task"` becomes `"    - [x] Indented task"`.

## Line ending handling

### CRLF normalization

Both `parseTaskContent` and `buildTaskContext` normalize Windows-style CRLF
(`\r\n`) line endings to Unix-style LF (`\n`) before processing:

```typescript
const normalized = content.replace(/\r\n/g, "\n");
```

**Why is this done in both functions rather than once at file read time?**

The normalization is applied in each function independently because:

1. **`parseTaskContent` is a pure function** -- it accepts a string, not a file
   path. Callers may pass content from any source, not just `readFile`. The
   function cannot assume the input has been pre-normalized.

2. **`buildTaskContext` is also a pure function** -- it accepts the raw
   `TaskFile.content` field, which stores the *original* content as passed to
   `parseTaskContent` (before normalization). This means `content` may still
   contain CRLF sequences.

3. **Defensive design** -- normalizing at each entry point ensures the regex
   anchors (`^` and `$`) work correctly regardless of how the function is
   called. This is more robust than relying on a single normalization point that
   could be bypassed.

The test at `src/parser.test.ts:289-298` confirms that CRLF input produces
correct task text without trailing `\r` characters.

### Write behavior

`markTaskComplete` splits on `\n` and rejoins with `\n`, which means **the
output always uses LF line endings** regardless of the original file's line
ending style. See [Architecture & Concurrency](./architecture-and-concurrency.md#file-encoding-and-line-endings)
for the implications.

## Task file format expectations

### File extension

The parser accepts **any file path** -- `parseTaskFile` does not check or
enforce a `.md` extension. The [CLI entry point](../cli-orchestration/cli.md) (`src/cli.ts`) supplies file
paths via a glob pattern (e.g., `tasks/**/*.md`), so in practice files are
typically `.md`, but the parser itself is extension-agnostic.

### File encoding

Both `readFile` and `writeFile` calls in the parser explicitly specify
`"utf-8"` encoding. Non-UTF-8 files will be read as UTF-8, which may produce
garbled text but will not throw an error from Node.js. The parsed task text
would contain mojibake characters.

## Related documentation

- [Overview](./overview.md) -- what the parser does and why
- [API Reference](./api-reference.md) -- function signatures and type definitions
- [Architecture & Concurrency](./architecture-and-concurrency.md) -- file I/O
  safety analysis
- [Testing Guide](./testing-guide.md) -- tests that verify accepted and
  rejected syntax patterns
- [Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md) --
  recommended file structure and how context filtering works
- [Parser Tests](../testing/parser-tests.md) -- Test suite verifying accepted
  and rejected syntax patterns, CRLF handling, and mode prefix parsing
- [Format Tests](../testing/format-tests.md) -- Related pure-function test
  patterns used in the testing suite
