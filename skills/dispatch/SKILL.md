---
name: dispatch
description: >
  Orchestrate work using the Dispatch MCP server (@pruddiman/dispatch). Use when the
  user wants to spec issues, dispatch tasks, plan execution order, manage
  dependencies between issues, or run any dispatch operation. Covers correct
  spec ordering, dependency analysis, and the spec-plan-execute pipeline.
metadata:
  author: pruddiman
  version: "2.1.0"
license: MIT
---

# Dispatch Orchestration

Dispatch turns issues into working code: fetch work items → generate structured specs → plan and execute tasks in isolated AI sessions → commit and open PRs.

**Pipeline:** Issues → `spec_generate` → Spec files → `dispatch_run` → Plan → Execute → Commit/PR

Use MCP tools directly. Do not shell out to the `dispatch` CLI.

## MCP Tool Reference

| Category | Tool | What it does |
|---|---|---|
| **Spec** | `spec_generate` | Generate spec files from issue IDs, glob pattern, or inline text |
| | `spec_list` | List spec files in `.dispatch/specs/` |
| | `spec_read` | Read a spec file's contents |
| | `spec_runs_list` | List recent spec generation runs |
| | `spec_run_status` | Get status of a specific spec run by runId |
| **Dispatch** | `dispatch_run` | Execute dispatch pipeline for one or more issues |
| | `dispatch_dry_run` | Preview tasks without executing (synchronous) |
| **Monitor** | `status_get` | Get run status and per-task details by runId |
| | `runs_list` | List recent dispatch runs (filter by status) |
| | `issues_list` | List open issues from the configured datasource |
| | `issues_fetch` | Fetch full details for specific issues |
| **Recovery** | `run_retry` | Re-run all failed tasks from a previous run |
| | `task_retry` | Retry a single failed task by taskId |
| **Config** | `config_get` | Read the current Dispatch configuration |

## Async Pattern — runId + Polling

`spec_generate` and `dispatch_run` are **fire-and-forget**: they return a `runId` immediately; progress arrives as logging notifications.

**Always poll for completion before moving to the next step:**

```
# After spec_generate
loop: status = spec_run_status({ runId }); break if status.status in ["completed","failed"]

# After dispatch_run
loop: status = status_get({ runId }); break if status.run.status in ["completed","failed"]
```

`dispatch_dry_run` is synchronous — returns results directly, no runId.

## Pipeline Phases

| Phase | When to use |
|---|---|
| `spec_generate` | Issue is vague/complex, needs task breakdown, or involves multiple agents. Skip if a good spec already exists. |
| Planning (default) | Complex tasks, unfamiliar code, refactors. Skip with `noPlan: true` for mechanical/obvious changes. |
| `dispatch_dry_run` | Always dry-run before dispatching an unfamiliar spec to verify task count and ordering. |

## Spec Ordering — The Core Discipline

**This is the most critical part of using Dispatch correctly.**

### The Rule

**Never spec an issue whose prerequisites have not been fully implemented and merged.**

The spec agent explores the *current* codebase. If issue B depends on code that issue A creates, and A hasn't been executed yet, B's spec will be wrong — written against a codebase missing B's foundations. A spec that exists for A is not enough; A must be fully executed and its code present on disk.

### Dependency Analysis

Before speccing anything:

1. `issues_list` → `issues_fetch` to read all issue descriptions.
2. Map dependencies: if B imports or calls something A creates, B depends on A.
3. Group into layers: Layer 0 = no deps. Layer 1 = depends on layer 0. Etc.
4. Independent issues within a layer can be specced and executed concurrently.

### Execution Pattern

```
Layer 0 (no deps):   spec_generate → poll → dispatch_run → poll
                                                  ↓
Layer 1 (needs 0):   spec_generate → poll → dispatch_run → poll
                                                  ↓
Layer 2 (needs 1):   spec_generate → poll → dispatch_run → poll
```

Spec layer N only after layer N-1 is **executed and complete** — not just specced.

### Concrete Example

```
Issues: #10 user model, #11 user API (needs #10), #12 admin dashboard (needs #11)
        #20 logging (independent),  #21 request tracing (needs #20)

Layer 0: #10, #20  →  spec + dispatch together (concurrent, no prerequisites)
Layer 1: #11, #21  →  spec + dispatch after layer 0 done (concurrent within layer)
Layer 2: #12       →  spec + dispatch after layer 1 done
```

### Anti-Patterns

```
# BAD: speccing everything at once — #11's spec references code that doesn't exist yet
spec_generate({ issues: "10,11,12,20,21" })

# BAD: not waiting for spec before dispatch — spec may still be running
rid = spec_generate({ issues: "42" }); dispatch_run({ issueIds: ["42"] })

# BAD: speccing layer 1 before layer 0 is executed — spec alone is not enough
spec_generate({ issues: "10" })
spec_generate({ issues: "11" })   # WRONG: #10's code doesn't exist yet
```

### Pre-Spec Checklist

Before calling `spec_generate` on any issue:

1. What code does it depend on? (imports, APIs, schemas, utilities)
2. Does that code exist in the codebase *right now*? (verify with grep/glob)
3. If not — which issue creates it? Execute that issue first, fully.
4. Are there other issues at the same dependency layer? Spec them together.

## Task Ordering Inside Specs

`spec_generate` tags tasks automatically. You do not write P/S/I tags — understand them to read generated specs:

- `(P)` **Parallel-safe** — runs concurrently with adjacent `(P)` tasks
- `(S)` **Serial/dependent** — waits for all prior tasks, then runs alone (caps the current group)
- `(I)` **Isolated/barrier** — runs completely alone; used for validation steps (tests, lint, build)

See [references/ordering-reference.md](references/ordering-reference.md) for the full grouping algorithm and edge cases.

## References

- [references/workflow-recipes.md](references/workflow-recipes.md) — single issue, multi-issue, retry, and feature-branch recipes
- [references/ordering-reference.md](references/ordering-reference.md) — P/S/I grouping algorithm with walkthrough examples
- [references/troubleshooting.md](references/troubleshooting.md) — symptom/cause/fix for common failures
