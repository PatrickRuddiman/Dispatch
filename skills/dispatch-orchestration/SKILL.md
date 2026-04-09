---
name: dispatch-orchestration
description: >
  Orchestrate work using the Dispatch MCP server (@pruddiman/dispatch). Use when the
  user wants to spec issues, dispatch tasks, plan execution order, manage
  dependencies between issues, or run any dispatch operation. Covers correct
  spec ordering, dependency analysis, and the spec-plan-execute pipeline.
metadata:
  author: pruddiman
  version: "2.0.0"
license: MIT
---

# Dispatch Orchestration

Dispatch is an AI agent orchestration tool that turns issues into working code. It fetches work items from GitHub Issues, Azure DevOps, or local markdown files, generates structured specs (with correctly ordered and tagged tasks), plans and executes each task in isolated AI sessions, then commits and opens PRs.

**Pipeline:** Issues → `spec_generate` → Spec files → `dispatch_run` → Plan → Execute → Commit/PR

Dispatch exposes all operations as MCP tools. Use these tools directly — do not shell out to the `dispatch` CLI.

## MCP Tool Reference

### Spec Tools

| Tool | What it does |
|---|---|
| `spec_generate` | Generate spec files from issue IDs, glob pattern, or inline text |
| `spec_list` | List spec files in `.dispatch/specs/` |
| `spec_read` | Read the contents of a spec file |
| `spec_runs_list` | List recent spec generation runs with status |
| `spec_run_status` | Get status of a specific spec generation run |

### Dispatch Tools

| Tool | What it does |
|---|---|
| `dispatch_run` | Execute dispatch pipeline for one or more issue IDs |
| `dispatch_dry_run` | Preview tasks without executing anything |

### Monitor Tools

| Tool | What it does |
|---|---|
| `status_get` | Get run status and per-task details by runId |
| `runs_list` | List recent dispatch runs (optionally filter by status) |
| `issues_list` | List open issues from the configured datasource |
| `issues_fetch` | Fetch full details for specific issues |

### Recovery Tools

| Tool | What it does |
|---|---|
| `run_retry` | Re-run all failed tasks from a previous run |
| `task_retry` | Retry a single failed task by taskId |

### Config Tools

| Tool | What it does |
|---|---|
| `config_get` | Read the current Dispatch configuration |

## Async Pattern — runId + Polling

`spec_generate` and `dispatch_run` are **fire-and-forget**: they return a `runId` immediately and execute in the background. Progress is pushed to the MCP client as logging notifications.

**Always poll for completion** before moving to the next step:

```
runId = spec_generate({ issues: "42" })          # returns immediately
# ... logging notifications arrive as progress ...
loop:
  status = spec_run_status({ runId })
  if status.status in ["completed", "failed"]: break
  wait briefly
```

```
runId = dispatch_run({ issueIds: ["42"] })        # returns immediately
loop:
  status = status_get({ runId })
  if status.run.status in ["completed", "failed"]: break
  wait briefly
```

`dispatch_dry_run` is **synchronous** — it returns results directly with no runId.

## Pipeline Phases

### When to Spec (`spec_generate`)

Use `spec_generate` when:
- The issue is vague or complex and needs codebase exploration
- You need structured task lists with ordering tags
- Multiple people/agents will execute the work

Skip `spec_generate` when:
- You already have a well-structured markdown task file in `.dispatch/specs/`
- The task is a single, obvious change

### When to Plan (default) vs Skip (`noPlan: true`)

The planner reads each task, explores the codebase, and produces a line-level execution plan.

- **Use planning (default):** Complex tasks, unfamiliar code, refactors
- **Skip planning (`noPlan: true`):** Simple/mechanical tasks, typo fixes, config changes

### When to Dry-Run (`dispatch_dry_run`)

Always dry-run before dispatching unfamiliar specs to verify task count, ordering, and grouping.

## Spec Ordering — The Core Discipline

**This is the most critical part of using Dispatch correctly.** The primary job when orchestrating is deciding *which* issues to spec and *when* — not writing the P/S/I tags inside specs (`spec_generate` handles task-level tagging automatically).

### The Rule

**Never spec an issue whose prerequisites are not fully implemented.**

The spec agent explores the current codebase when generating a spec. If issue B depends on code that issue A creates, and A hasn't been executed yet, then B's spec will be wrong — it will be written against a codebase that's missing the foundations B needs.

### Dependency Analysis Workflow

Before speccing anything, analyze all issues and build a dependency graph:

1. **Read all issue descriptions.** Use `issues_list` then `issues_fetch` to get full details.
2. **Map dependencies.** If issue B says "add API endpoints for user model" and issue A says "add user model", then B depends on A.
3. **Identify independent issues.** Issues with no shared dependencies can be specced and executed in parallel.
4. **Number or order specs by dependency layer.** Layer 0 has no deps. Layer 1 depends on layer 0. Layer 2 depends on layer 1. Etc.

### Execution Pattern

```
Layer 0 (no deps):      spec_generate → dispatch_run → poll until done
                                              ↓
Layer 1 (depends on 0):  spec_generate → dispatch_run → poll until done
                                              ↓
Layer 2 (depends on 1):  spec_generate → dispatch_run → poll until done
```

**Within each layer**, independent issues can be specced and dispatched concurrently.
**Between layers**, you must wait for the prior layer to complete before speccing the next.

### Concrete Example

**Issues:**
- #10 "Add user model" — no dependencies
- #11 "Add user API endpoints" — depends on #10 (imports user model)
- #12 "Add admin dashboard" — depends on #11 (calls user API)
- #20 "Add logging middleware" — no dependencies (independent of #10-#12)
- #21 "Add request tracing" — depends on #20 (extends logging middleware)

**Dependency graph:**
```
Layer 0: #10, #20          (independent — parallel)
Layer 1: #11, #21          (#11 depends on #10; #21 depends on #20 — parallel within layer)
Layer 2: #12               (depends on #11)
```

**Correct workflow:**
```
# Layer 0 — spec and execute all independent issues
rid0a = spec_generate({ issues: "10,20" })         # safe: no prerequisites
poll spec_run_status(rid0a) until completed

rid1 = dispatch_run({ issueIds: ["10", "20"], concurrency: 2 })
poll status_get(rid1) until completed

# Layer 1 — now safe to spec issues that depend on layer 0
rid0b = spec_generate({ issues: "11,21" })         # safe: #10 and #20 code exists
poll spec_run_status(rid0b) until completed

rid2 = dispatch_run({ issueIds: ["11", "21"], concurrency: 2 })
poll status_get(rid2) until completed

# Layer 2 — depends on layer 1
rid0c = spec_generate({ issues: "12" })            # safe: #11 code exists
poll spec_run_status(rid0c) until completed

rid3 = dispatch_run({ issueIds: ["12"] })
poll status_get(rid3) until completed
```

**Incorrect workflows:**
```
# BAD: speccing everything at once
spec_generate({ issues: "10,11,12,20,21" })    # #11's spec can't reference #10's code

# BAD: not waiting for spec to finish before dispatching
rid = spec_generate({ issues: "42" })
dispatch_run({ issueIds: ["42"] })             # spec may still be generating!

# BAD: speccing layer 1 before layer 0 is EXECUTED (not just specced)
spec_generate({ issues: "10,20" })
spec_generate({ issues: "11,21" })             # WRONG: #10 and #20 haven't been executed yet
```

### Decision Checklist (Before Speccing an Issue)

Ask these questions for each issue before calling `spec_generate`:

1. **What code does this issue depend on?** (imports, APIs, schemas, utilities)
2. **Does that code exist in the codebase right now?** Check with grep/glob tools.
3. **If not, which issue creates it?** That issue must be fully executed first.
4. **Are there other issues at the same dependency layer?** Spec them together for parallelism.

If all dependencies exist in the codebase → safe to spec.
If any dependency is missing → wait. Spec and execute the prerequisite first.

## How Task Ordering Works Inside Specs

> **You don't need to write P/S/I tags yourself.** `spec_generate` produces specs with correctly tagged and ordered tasks automatically. This section is background so you understand how Dispatch executes the specs it generates.

Each task in a spec has an execution-mode prefix:

- `(P)` **Parallel-safe** — runs concurrently with other `(P)` tasks
- `(S)` **Serial / dependent** — waits for all prior tasks, then runs alone
- `(I)` **Isolated / barrier** — runs completely alone (for validation: tests, lint, build)

Dispatch groups consecutive `(P)` tasks together and runs them concurrently. An `(S)` task caps the current group. An `(I)` task flushes everything and runs alone. Groups execute sequentially.

**Example of a generated spec's tasks:**
```markdown
- [ ] (P) Add validation helper to utils
- [ ] (P) Add unit tests for validation helper
- [ ] (S) Refactor form component to use helper      ← waits for above
- [ ] (P) Update form documentation
- [ ] (I) Run the full test suite                     ← runs alone, last
```

See [references/ordering-reference.md](references/ordering-reference.md) for the full grouping algorithm and edge cases.

## Workflow Recipes

### Single issue, full pipeline
```
# 1. Generate spec
rid_spec = spec_generate({ issues: "42" })
poll spec_run_status({ runId: rid_spec }) until completed

# 2. Review the spec
spec_list({})
spec_read({ file: "42-my-issue.md" })

# 3. Preview tasks
dispatch_dry_run({ issueIds: ["42"] })

# 4. Execute
rid_run = dispatch_run({ issueIds: ["42"] })
poll status_get({ runId: rid_run }) until completed
```

### Multiple independent issues
```
rid_spec = spec_generate({ issues: "42,43,44" })
poll spec_run_status({ runId: rid_spec }) until completed

rid_run = dispatch_run({ issueIds: ["42", "43", "44"], concurrency: 3 })
poll status_get({ runId: rid_run }) until completed
```

### Dependent issue chain
```
# Layer 0
rid_s0 = spec_generate({ issues: "42" })
poll spec_run_status({ runId: rid_s0 }) until completed
rid_r0 = dispatch_run({ issueIds: ["42"] })
poll status_get({ runId: rid_r0 }) until completed

# Layer 1 — safe now that 42 is implemented
rid_s1 = spec_generate({ issues: "43" })
poll spec_run_status({ runId: rid_s1 }) until completed
rid_r1 = dispatch_run({ issueIds: ["43"] })
poll status_get({ runId: rid_r1 }) until completed
```

### Regenerate a spec (respec)
```
# Just call spec_generate again — it overwrites the existing spec file
rid = spec_generate({ issues: "42" })
poll spec_run_status({ runId: rid }) until completed
```

### Skip planning for a simple task
```
rid = dispatch_run({ issueIds: ["42"], noPlan: true })
poll status_get({ runId: rid }) until completed
```

### From inline description
```
rid = spec_generate({ issues: "add dark mode toggle to settings page" })
poll spec_run_status({ runId: rid }) until completed
```

### Retry failed tasks
```
# After a run has failures:
status = status_get({ runId: "abc-123" })   # inspect which tasks failed

# Retry all failures in the run
rid_retry = run_retry({ runId: "abc-123" })
poll status_get({ runId: rid_retry }) until completed

# Or retry a single specific task
rid_task = task_retry({ runId: "abc-123", taskId: "42:3" })
poll status_get({ runId: rid_task }) until completed
```

### Check recent activity
```
runs_list({})                              # all recent runs
runs_list({ status: "failed" })           # only failures
runs_list({ status: "running" })          # in-progress
spec_runs_list({})                        # recent spec generation runs
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Spec references code that doesn't exist | Prerequisite issue hasn't been executed | Execute the prerequisite first, then call `spec_generate` again |
| `dispatch_run` tasks fail — "file not found" or "symbol not found" | Task depends on code from a prior issue that isn't done | Execute issues in dependency order; re-spec if needed |
| Spec quality is poor / tasks seem wrong | Spec was generated before prerequisite code existed | Execute prerequisites, then `spec_generate` the issue again |
| Planner times out | Complex task | Pass `planTimeout` (minutes) or `noPlan: true` for simpler tasks |
| Too slow — everything sequential | Issues dispatched one at a time despite being independent | Identify independent issues and spec/execute with `concurrency` > 1 |
| `spec_run_status` shows failed | Spec pipeline error | Check `error` field in status response; re-run `spec_generate` |
| `status_get` shows tasks stuck in `running` | Agent hung | Use `run_retry` to re-run; check logs via logging notifications |
