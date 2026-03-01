# Markdown Datasource

The markdown datasource reads and writes `.md` files from a local directory,
treating each file as a work item or spec. It is implemented in
`src/datasources/md.ts` and registered under the name `"md"` in the datasource
registry.

## What it does

The markdown datasource maps the five `Datasource` interface operations onto
local filesystem operations:

| Operation | Filesystem operation | Target path |
|-----------|---------------------|-------------|
| `list()` | `readdir()` + `readFile()` for each `.md` file | `<cwd>/.dispatch/specs/` |
| `fetch()` | `readFile()` | `<cwd>/.dispatch/specs/<id>.md` |
| `update()` | `writeFile()` | `<cwd>/.dispatch/specs/<id>.md` |
| `close()` | `rename()` (move to archive) | `<cwd>/.dispatch/specs/archive/<id>.md` |
| `create()` | `writeFile()` | `<cwd>/.dispatch/specs/<slug>.md` |

All operations use Node.js `fs/promises` -- no external CLI tools or network
calls are required. This makes the markdown datasource fully offline and the
fastest of the three datasource implementations.

## Why it exists

The markdown datasource enables local-first workflows where markdown files
serve as the source of truth for work items. Use cases include:

- **Offline development.** No network access or external tool installation
  required.
- **Quick prototyping.** Create specs as markdown files without setting up a
  tracker.
- **Testing and development.** Use local files to test dispatch-tasks pipelines
  without connecting to GitHub or Azure DevOps.
- **Version-controlled specs.** Markdown files can be committed to git, giving
  the spec lifecycle full version control.

## Directory structure

The default specs directory is `.dispatch/specs/` relative to the working
directory (`src/datasources/md.ts:16`). This is not configurable through the
datasource interface -- it is always resolved as `join(cwd, ".dispatch/specs")`.

```
project/
  .dispatch/
    specs/
      my-feature.md
      bug-fix.md
      archive/
        completed-feature.md
```

The `archive/` subdirectory is created automatically by `close()` when the
first spec is archived. It does not exist by default.

## File naming and identification

Work items are identified by their filename. The `IssueDetails.number` field
contains the full filename including the `.md` extension (e.g.,
`"my-feature.md"`).

### Automatic `.md` extension handling

The `fetch()`, `update()`, and `close()` methods accept an `issueId` either
with or without the `.md` extension (`src/datasources/md.ts:79`):

- `fetch("my-feature")` reads `my-feature.md`
- `fetch("my-feature.md")` reads `my-feature.md`

### Title slugification in `create()`

When creating a new spec, the title is slugified to produce the filename
(`src/datasources/md.ts:104`):

```
title.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")   // Replace non-alphanumeric runs with hyphens
  .replace(/^-|-$/g, "")          // Trim leading/trailing hyphens
  + ".md"
```

Examples:

| Title | Filename |
|-------|----------|
| `"My New Feature"` | `my-new-feature.md` |
| `"Bug Fix #123"` | `bug-fix-123.md` |
| `"--Leading Dashes--"` | `leading-dashes.md` |
| `"UPPERCASE"` | `uppercase.md` |

### Filename collision risk

The `create()` method uses `writeFile()` without checking for existing files
(`src/datasources/md.ts:106`). If two specs produce the same slugified
filename, the second `create()` call will **silently overwrite** the first
file. There is no collision detection or conflict resolution.

For example, creating specs with titles `"My Feature!"` and `"My Feature?"` would
both produce `my-feature.md`, and the second call would overwrite the first.

## Title extraction

The `extractTitle()` helper function (`src/datasources/md.ts:32`, exported)
extracts the title from markdown content:

1. Looks for the first `# Heading` line (ATX heading level 1) using the regex
   `/^#\s+(.+)$/m`.
2. If found, returns the heading text (trimmed).
3. If no H1 heading exists, falls back to the filename stem (without `.md`
   extension).

This means the `IssueDetails.title` may differ from the original title passed
to `create()`. The `create()` method writes the `body` parameter as-is to the
file. If the body does not contain an H1 heading, the title in subsequent
`list()` or `fetch()` calls will be the filename stem, not the original title.

## Operation details

### `list()`

Lists all `.md` files in the specs directory, sorted alphabetically.

**Missing directory handling:** If the specs directory does not exist,
`list()` catches the `readdir()` error and returns an empty array
(`src/datasources/md.ts:61`). This is a graceful fallback -- no error is
thrown.

**Non-.md files ignored:** Only files ending in `.md` are included. Other
files (e.g., `.txt`, `.json`, images) are silently skipped.

**Subdirectories ignored:** `readdir()` returns both files and directories.
The `.endsWith(".md")` filter excludes directories, including the `archive/`
subdirectory. Archived specs are not included in list results.

**Field mapping:**

| Source | `IssueDetails` field | Value |
|--------|---------------------|-------|
| Filename | `number` | Full filename (e.g., `"my-feature.md"`) |
| First H1 or filename | `title` | Extracted via `extractTitle()` |
| File content | `body` | Complete file content as-is |
| _(not available)_ | `labels` | Always `[]` |
| _(hardcoded)_ | `state` | Always `"open"` |
| Directory path + filename | `url` | Local filesystem path (not a URL) |
| _(not available)_ | `comments` | Always `[]` |
| _(not available)_ | `acceptanceCriteria` | Always `""` |

**Note on `url`:** The `url` field contains a local filesystem path (e.g.,
`/home/user/project/.dispatch/specs/my-feature.md`), not an HTTP URL. This
differs from the GitHub and Azure DevOps datasources which provide web URLs.

### `fetch()`

Reads a single markdown file by its identifier. Throws an `ENOENT` error if
the file does not exist (unlike `list()`, which handles missing directories
gracefully).

### `update()`

Writes new body content to an existing spec file.

**Title parameter is ignored:** The `_title` parameter is accepted by the
method signature (to satisfy the `Datasource` interface) but is **not used**
(`src/datasources/md.ts:85`). Only the `body` parameter is written to the
file. If you need to change the title, you must include the new title as an H1
heading in the body content.

This means calling `update("my-spec", "New Title", "new body")` will write
`"new body"` to the file, and subsequent `fetch()` calls will extract the title
from the body content (falling back to the filename if no H1 heading is found).

### `close()`

Moves the spec file from the specs directory to an `archive/` subdirectory.

The archive directory is created with `mkdir({ recursive: true })` if it does
not already exist (`src/datasources/md.ts:97`).

**Not a state change:** Unlike GitHub and Azure DevOps where `close()` changes
a state field, the markdown datasource physically moves the file. The file
content is preserved unchanged.

**Reversibility:** To "reopen" an archived spec, manually move it back from
`archive/` to the parent specs directory.

**Archive collision:** If a file with the same name already exists in the
archive directory, `rename()` will overwrite it silently (this is standard
`fs.rename()` behavior on most platforms).

### `create()`

Creates a new spec file with a slugified filename.

**Directory creation:** The specs directory is created with
`mkdir({ recursive: true })` if it does not already exist. This handles the
case where `.dispatch/specs/` has never been created.

**Body as-is:** The `body` parameter is written to the file as-is. If you want
the title to be extractable by `extractTitle()`, include an H1 heading in the
body.

**Return value note:** The returned `IssueDetails.title` is extracted from the
written body via `extractTitle()`, which may differ from the `title` parameter
passed to `create()`. For example, `create("My Feature", "no heading here")`
returns `title: "my-feature"` (the filename stem) because the body has no H1
heading.

## Version control considerations

Markdown spec files live in the project directory and can be version-controlled
with git:

- **Committing specs:** Run `git add .dispatch/specs/` to stage spec files.
  The dispatch-tasks orchestrator may auto-commit changes during the dispatch
  pipeline.
- **Archived specs:** The `archive/` subdirectory should also be committed if
  you want to track closed specs.
- **`.gitignore`:** If you do not want specs committed, add `.dispatch/specs/`
  to `.gitignore`.
- **Concurrent access:** There is no file locking. If multiple dispatch-tasks
  processes or users modify the same spec file concurrently, data loss may
  occur from write conflicts.

## Troubleshooting

### Empty list results

Check that:
1. `.dispatch/specs/` exists relative to the working directory.
2. The directory contains `.md` files (not just `.txt` or other formats).
3. You are running from the correct working directory (or passing `--cwd`).

### "ENOENT: no such file or directory" on fetch

The specified spec file does not exist. Verify the filename and that it is in
`.dispatch/specs/`. Remember that `fetch()` accepts the ID with or without the
`.md` extension.

### Title not matching what was passed to `create()`

The title is extracted from the file content, not stored separately. If the
body does not contain an H1 heading (`# Title`), the title falls back to the
filename stem. Include an H1 heading in the body for consistent titles.

### File overwritten on `create()`

Two specs with titles that produce the same slug (e.g., `"My Feature!"` and
`"My Feature?"`) will collide. Ensure unique titles or use distinct naming.

### Auto-detection does not select markdown

The auto-detection system (`detectDatasource()`) only matches GitHub and Azure
DevOps remote URLs. It never auto-detects `"md"`. To use the markdown
datasource, always pass `--source md` explicitly.

## Related documentation

- [Datasource Overview](./overview.md) -- Interface definitions, registry,
  and auto-detection
- [GitHub Datasource](./github-datasource.md) -- GitHub alternative
- [Azure DevOps Datasource](./azdevops-datasource.md) -- Azure DevOps
  alternative
- [Integrations & Troubleshooting](./integrations.md) -- Cross-cutting
  error-handling concerns
