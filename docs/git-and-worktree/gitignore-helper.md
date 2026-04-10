# Gitignore Helper

The gitignore helper (`src/helpers/gitignore.ts`) exports a single function,
`ensureGitignoreEntry`, that guarantees a given pattern appears in the
repository's `.gitignore` file. It is called once per orchestrator run to keep
`.dispatch/worktrees/` out of version control.

## What it does

`ensureGitignoreEntry(repoRoot, entry)` reads the repository's `.gitignore`
file, checks whether the specified pattern is already present (with
trailing-slash normalization), and appends it if missing. The function is
designed to be non-fatal — both read and write errors are handled gracefully
so that a permissions issue never aborts the dispatch run.

## How it works

`ensureGitignoreEntry(repoRoot, entry)` follows this sequence:

1. **Read** `.gitignore` from `repoRoot`. If the file does not exist, treat the
   contents as an empty string (the read error is silently caught).

2. **Check for duplicates.** Split the contents into trimmed lines and check
   whether the entry already exists. The check matches both the entry as given
   and the entry with any trailing slash stripped (the "bare" form). This
   prevents duplicates when the user already has `.dispatch/worktrees` and the
   function tries to add `.dispatch/worktrees/`.

3. **Append** the entry on a new line if it is not already present. If the
   existing file does not end with a newline, a separator newline is inserted
   first.

4. **Write** the updated contents back. If the write fails (e.g., permission
   error, read-only filesystem), the error is logged as a warning and the
   function returns normally.

## Duplicate detection

The deduplication logic handles two forms of the same entry:

| Existing line | Entry to add | Match? |
|--------------|--------------|--------|
| `.dispatch/worktrees/` | `.dispatch/worktrees/` | Yes (exact) |
| `.dispatch/worktrees` | `.dispatch/worktrees/` | Yes (bare match) |
| `.dispatch/worktrees/` | `.dispatch/worktrees` | Yes (bare match) |
| `.dispatch/worktree` | `.dispatch/worktrees/` | No |
| `# .dispatch/worktrees/` | `.dispatch/worktrees/` | No (commented out) |

The line comparison uses `Array.includes` after trimming each line. This is
case-sensitive — `.Dispatch/Worktrees/` would not match `.dispatch/worktrees/`.
On case-insensitive filesystems (macOS default, Windows), this could lead to a
redundant entry, though the `.gitignore` itself is still case-sensitive per
git's documentation.

## Error handling

The function has two error paths, both deliberately non-fatal:

### Read errors

Any error from `readFile` is caught silently. The function proceeds as if the
file does not exist, which means it will attempt to create the file by writing
the entry. This handles:

- File does not exist (`ENOENT`)
- Permission denied on read (`EACCES`)
- Any other I/O error

### Write errors

Any error from `writeFile` is caught, logged as a warning via `log.warn`, and
the function returns normally. This handles:

- Permission denied on write (`EACCES`)
- Read-only filesystem (`EROFS`)
- Disk full (`ENOSPC`)

The rationale for non-fatal writes is stated in the JSDoc: "this is non-fatal
so a permissions issue won't abort the run." A missing `.gitignore` entry is a
cosmetic issue — worktree directories can always be manually added to
`.gitignore` or cleaned up after the fact.

## Race condition analysis

`ensureGitignoreEntry` performs a read-check-write sequence without file
locking. Two concurrent Dispatch processes could interleave as follows:

1. Process A reads `.gitignore` — entry is absent.
2. Process B reads `.gitignore` — entry is absent.
3. Process A writes `.gitignore` with the entry appended.
4. Process B writes `.gitignore` with the entry appended (using the old
   contents from step 2).

In this scenario, Process B's write overwrites Process A's write. The entry
is still present (Process B appended it), but any other changes Process A made
between reads would be lost. In practice, this race is unlikely to cause real
harm because:

- Only one Dispatch process typically runs per repository at a time.
- The only modification is appending a single line; the "lost" write from
  Process A would contain the same appended line.
- The `.gitignore` file is under version control, so any accidental data loss
  can be recovered with `git checkout`.

If concurrent Dispatch execution becomes a supported use case, the function
should use a file lock (e.g., `proper-lockfile` or `flock`) or an atomic
write-to-temp-then-rename pattern.

## When it is called

The [orchestrator](../cli-orchestration/orchestrator.md) calls `ensureGitignoreEntry` in `src/orchestrator/runner.ts:151`
during early startup, before any worktrees are created:

```
await ensureGitignoreEntry(m.cwd, ".dispatch/worktrees/");
```

This runs unconditionally — regardless of whether `useWorktrees` is enabled —
so that the `.gitignore` entry is present even when the user later switches to
worktree mode.

## Why not use writeFile atomically

Unlike `saveRunState`, this function uses a direct `writeFile` rather than a
write-to-temp-then-rename pattern. The tradeoff is:

- **Simpler code** for a low-stakes operation. A corrupted `.gitignore` is
  easily recovered from version control.
- **Slight risk** of a truncated file if the process is killed between the
  `open` and `write` phases of `writeFile`. Again, `git checkout -- .gitignore`
  recovers this trivially.

The atomic write pattern would be a strict improvement but has not been
prioritized given the low risk profile.

## Encoding and platform considerations

### File encoding

The module reads and writes `.gitignore` with explicit `"utf-8"` encoding
(at the `readFile` and `writeFile` calls). This matches git's own assumption
that `.gitignore` files are UTF-8 encoded.

### Windows paths

On Windows, `path.join(repoRoot, ".gitignore")` produces a path with
backslashes (e.g., `C:\repo\.gitignore`), which is correct for the `readFile`
and `writeFile` calls. The `entry` parameter (e.g., `.dispatch/worktrees/`)
uses forward slashes regardless of platform, which is correct for `.gitignore`
content — git always interprets `.gitignore` patterns with forward slashes,
even on Windows.

## Related documentation

- [Overview](./overview.md) — Group-level summary and design decisions
- [Authentication](./authentication.md) — OAuth device-flow authentication
  that runs during the same startup phase as this helper
- [Branch Validation](./branch-validation.md) — Branch name validation module
- [Worktree Management](./worktree-management.md) — The worktree module that
  creates the directories this helper keeps gitignored
- [Integrations](./integrations.md) — `fs/promises` usage details for read
  and write operations
- [Testing](./testing.md) — 8 tests covering deduplication, ENOENT handling,
  CRLF line endings, and write failures
- [Run State](./run-state.md) — SQLite-backed persistence that complements
  worktree lifecycle management
- [Orchestrator Pipeline](../cli-orchestration/orchestrator.md) — Where
  `ensureGitignoreEntry()` is called during the runner's early startup phase
- [Configuration](../cli-orchestration/configuration.md) — `.dispatch/`
  directory conventions and config file location
