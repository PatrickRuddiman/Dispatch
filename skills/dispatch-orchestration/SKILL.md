---
name: dispatch-orchestration
description: >
  Orchestrate work using the Dispatch CLI (@pruddiman/dispatch). Use when the
  user wants to spec issues, dispatch tasks, plan execution order, manage
  dependencies between issues, or run any dispatch command. Covers correct
  spec ordering, dependency analysis, and the spec-plan-execute pipeline.
metadata:
  author: pruddiman
  version: "1.0.0"
license: MIT
---

# Dispatch Orchestration

Dispatch is an AI agent orchestration CLI that turns issues into working code. It fetches work items from GitHub Issues, Azure DevOps, or local markdown files, generates structured specs (with correctly ordered and tagged tasks), plans and executes each task in isolated AI sessions, then commits and opens PRs.

**Pipeline:** Issues → `--spec` → Spec files → `dispatch` → Plan → Execute → Commit/PR

## CLI Quick Reference

| Command | What it does |
|---|---|
| `dispatch --spec 42,43` | Generate specs from issue IDs |
| `dispatch --spec "add dark mode"` | Generate spec from inline text |
| `dispatch --respec 42` | Regenerate an existing spec |
| `dispatch 42` | Execute issue (plan + execute) |
| `dispatch ".dispatch/specs/*.md"` | Execute specs by glob |
| `dispatch --dry-run 42` | Preview tasks without executing |
| `dispatch --no-plan 42` | Skip planner, execute directly |
| `dispatch --provider claude` | Use Claude Code as provider |
| `dispatch --concurrency 4` | Max parallel tasks |
| `dispatch --fix-tests 42` | Run tests and fix failures |
| `dispatch --feature my-feat 42,43` | Group issues into one feature branch |
| `dispatch config` | Interactive configuration wizard |

**Key flags:** `--plan-timeout <min>`, `--retries <n>`, `--spec-timeout <min>`, `--no-branch`, `--no-worktree`, `--verbose`

## Pipeline Phases

### When to Spec (`--spec`)

Use `--spec` when:
- The issue is vague or complex and needs codebase exploration
- You need structured task lists with ordering tags
- Multiple people/agents will execute the work

Skip `--spec` when:
- You already have a well-structured markdown task file
- The task is a single, obvious change

### When to Plan (default) vs Skip (`--no-plan`)

The planner reads each task, explores the codebase, and produces a line-level execution plan.

- **Use planning (default):** Complex tasks, unfamiliar code, refactors
- **Skip planning (`--no-plan`):** Simple/mechanical tasks, typo fixes, config changes

### When to Dry-Run (`--dry-run`)

Always dry-run before dispatching unfamiliar specs to verify task count, ordering, and grouping.

## Spec Ordering — The Core Discipline

**This is the most critical part of using Dispatch correctly.** The agent's primary job is deciding *which* issues to spec and *when* — not writing the P/S/I tags inside specs (Dispatch's `--spec` agent handles task-level tagging automatically).

### The Rule

**Never spec an issue whose prerequisites are not fully implemented.**

The spec agent explores the current codebase when generating a spec. If issue B depends on code that issue A creates, and A hasn't been executed yet, then B's spec will be wrong — it will be written against a codebase that's missing the foundations B needs.

### Dependency Analysis Workflow

Before speccing anything, analyze all issues and build a dependency graph:

1. **Read all issue descriptions.** Identify what each issue creates, modifies, or depends on.
2. **Map dependencies.** If issue B says "add API endpoints for user model" and issue A says "add user model", then B depends on A.
3. **Identify independent issues.** Issues with no shared dependencies can be specced and executed in parallel.
4. **Number or order specs by dependency layer.** Layer 0 has no deps. Layer 1 depends on layer 0. Layer 2 depends on layer 1. Etc.

### Execution Pattern

```
Layer 0 (no deps):      spec → execute → verify
                              ↓
Layer 1 (depends on 0):  spec → execute → verify
                              ↓
Layer 2 (depends on 1):  spec → execute → verify
```

**Within each layer**, independent issues can be specced and executed concurrently.
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
```bash
# Layer 0 — spec and execute all independent issues
dispatch --spec 10,20              # Safe: no prerequisites
dispatch 10,20 --concurrency 2    # Execute in parallel

# Layer 1 — now safe to spec issues that depend on layer 0
dispatch --spec 11,21              # Safe: #10 and #20 code exists
dispatch 11,21 --concurrency 2    # Execute in parallel

# Layer 2 — depends on layer 1
dispatch --spec 12                 # Safe: #11 code exists
dispatch 12                        # Execute
```

**Incorrect workflows:**
```bash
# BAD: speccing everything at once
dispatch --spec 10,11,12,20,21    # #11's spec can't reference #10's code (doesn't exist yet)

# BAD: executing out of order
dispatch 10,11,12                 # #11 may fail — #10's code doesn't exist when #11 starts

# BAD: speccing layer 1 before layer 0 is executed
dispatch --spec 10,20
dispatch --spec 11,21              # WRONG: #10 and #20 haven't been EXECUTED yet
```

### Decision Checklist (Before Speccing an Issue)

Ask these questions for each issue before running `dispatch --spec`:

1. **What code does this issue depend on?** (imports, APIs, schemas, utilities)
2. **Does that code exist in the codebase right now?** Check with grep/find.
3. **If not, which issue creates it?** That issue must be fully executed first.
4. **Are there other issues at the same dependency layer?** Spec them together for parallelism.

If all dependencies exist in the codebase → safe to spec.
If any dependency is missing → wait. Spec and execute the prerequisite first.

## How Task Ordering Works Inside Specs

> **You don't need to write P/S/I tags yourself.** `dispatch --spec` generates specs with correctly tagged and ordered tasks automatically. This section is background so you understand how Dispatch executes the specs it generates.

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
```bash
dispatch --spec 42                    # Generate spec
cat .dispatch/specs/42-*.md           # Review the spec
dispatch --dry-run 42                 # Preview tasks
dispatch 42                           # Plan + execute
```

### Multiple independent issues
```bash
dispatch --spec 42,43,44              # Spec concurrently (independent)
dispatch 42,43,44 --concurrency 3     # Execute concurrently
```

### Dependent issue chain
```bash
dispatch --spec 42 && dispatch 42     # Layer 0: foundation
dispatch --spec 43 && dispatch 43     # Layer 1: depends on 42
dispatch --spec 44 && dispatch 44     # Layer 2: depends on 43
```

### Mixed dependencies and independent issues
```bash
# Layer 0
dispatch --spec 10,20 && dispatch 10,20 --concurrency 2
# Layer 1
dispatch --spec 11,21 && dispatch 11,21 --concurrency 2
# Layer 2
dispatch --spec 12 && dispatch 12
```

### From inline description
```bash
dispatch --spec "add dark mode toggle to settings page"
dispatch ".dispatch/specs/*.md"
```

### Quick fix, skip planning
```bash
dispatch --no-plan 42
```

### Fix failing tests
```bash
dispatch --fix-tests 42
```

### Feature branch grouping
```bash
dispatch --feature user-system 10,11,12    # All on one branch
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Spec references code that doesn't exist | Prerequisite issue hasn't been executed yet | Execute the prerequisite first, then `--respec` |
| Task fails — "file not found" or "symbol not found" | Task depends on code from a prior issue that isn't done | Execute issues in dependency order; re-spec if needed |
| Spec quality is poor / tasks seem wrong | Spec was generated before prerequisite code existed | Execute prerequisites, then `dispatch --respec` |
| Planner times out | Complex task + default 30-min limit | `--plan-timeout 60` or `--no-plan` for simpler tasks |
| Too slow — everything sequential | Issues dispatched one at a time despite being independent | Identify independent issues and spec/execute them concurrently |
| Task runs but doesn't commit | Commit instructions missing from task | Re-spec with `--respec` (spec agent embeds commit instructions) |
