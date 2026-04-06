# P/S/I Ordering Reference

Detailed reference for Dispatch's task grouping algorithm and execution ordering.

## The `groupTasksByMode()` Algorithm

The algorithm in `src/parser.ts` converts a flat list of tagged tasks into ordered execution groups:

```
Input:  flat list of tasks, each with mode: "parallel" | "serial" | "isolated"
Output: array of groups (Task[][]), executed sequentially
```

**Rules:**

1. **Parallel `(P)`** — accumulate into the current group
2. **Serial `(S)`** — append to the current group, then start a new empty group (acts as a "cap")
3. **Isolated `(I)`** — flush any accumulated tasks as their own group, then create a solo group for the isolated task

After processing all tasks, any remaining accumulated parallel tasks form a final group.

## Walkthrough Examples

### Example 1: Mixed modes

```markdown
- [ ] (P) Task A
- [ ] (P) Task B
- [ ] (S) Task C
- [ ] (P) Task D
- [ ] (P) Task E
- [ ] (I) Task F
- [ ] (P) Task G
```

**Step-by-step:**

| Task | Mode | Action | Current group | Groups so far |
|------|------|--------|--------------|---------------|
| A | P | accumulate | [A] | [] |
| B | P | accumulate | [A, B] | [] |
| C | S | cap group | [] | [[A, B, C]] |
| D | P | accumulate | [D] | [[A, B, C]] |
| E | P | accumulate | [D, E] | [[A, B, C]] |
| F | I | flush + solo | [] | [[A, B, C], [D, E], [F]] |
| G | P | accumulate | [G] | [[A, B, C], [D, E], [F]] |
| end | — | flush remaining | [] | [[A, B, C], [D, E], [F], [G]] |

**Result:** `[[A, B, C], [D, E], [F], [G]]`

**Execution:**
1. A, B run concurrently → C runs (S caps the group, so C waits for A and B)
2. D, E run concurrently
3. F runs alone (isolated)
4. G runs alone (only task in its group)

### Example 2: All parallel

```markdown
- [ ] (P) Task A
- [ ] (P) Task B
- [ ] (P) Task C
```

**Result:** `[[A, B, C]]` — all three run concurrently in one group.

### Example 3: All serial

```markdown
- [ ] (S) Task A
- [ ] (S) Task B
- [ ] (S) Task C
```

**Result:** `[[A], [B], [C]]` — each runs alone, sequentially.

### Example 4: Parallel then isolated validation

```markdown
- [ ] (P) Implement feature module
- [ ] (P) Write unit tests for feature
- [ ] (P) Update documentation
- [ ] (I) Run full test suite
- [ ] (I) Run linter
```

**Result:** `[[module, tests, docs], [test suite], [linter]]`

**Execution:**
1. Module, tests, and docs all run concurrently
2. Full test suite runs alone
3. Linter runs alone

### Example 5: Serial dependency chain

```markdown
- [ ] (P) Create database schema migration
- [ ] (P) Add seed data script
- [ ] (S) Run migration and seed the database
- [ ] (P) Implement API endpoints using new schema
- [ ] (P) Write API integration tests
- [ ] (I) Run all tests
```

**Result:** `[[schema, seed, run migration], [endpoints, tests], [run all tests]]`

**Execution:**
1. Schema and seed created concurrently, then migration runs (S caps)
2. Endpoints and tests written concurrently (safe — schema exists now)
3. Full test suite runs alone

### Example 6: Isolated as a phase gate

```markdown
- [ ] (P) Refactor module A
- [ ] (P) Refactor module B
- [ ] (I) Run tests to verify refactors
- [ ] (P) Update module C (imports from A and B)
- [ ] (P) Update module D (imports from A and B)
- [ ] (I) Run final test suite
```

**Result:** `[[A, B], [verify], [C, D], [final tests]]`

The first `(I)` acts as a phase gate — it verifies the refactors before dependent work begins.

## Edge Cases

### Single task

```markdown
- [ ] (P) Only task
```

**Result:** `[[Only task]]` — works fine regardless of mode prefix.

### Serial followed immediately by parallel

```markdown
- [ ] (S) Setup step
- [ ] (P) Task A
- [ ] (P) Task B
```

**Result:** `[[Setup step], [A, B]]` — serial creates its own group, then parallel tasks accumulate.

### Isolated at the very start

```markdown
- [ ] (I) Clean build artifacts
- [ ] (P) Task A
- [ ] (P) Task B
```

**Result:** `[[Clean], [A, B]]` — isolated runs first (no prior tasks to flush), then parallel group.

### No mode prefix (defaults to serial)

```markdown
- [ ] Task without prefix
- [ ] (P) Parallel task
```

**Result:** `[[no-prefix, parallel]]` — the untagged task is treated as serial, which caps the group after it. But since the parallel task follows, it starts a new group... Actually: the untagged task (serial) starts accumulating, the `(P)` task accumulates into the same group. Then `(S)` caps — but there's no `(S)`. The untagged task is serial, so it caps immediately: `[[no-prefix], [parallel]]`.

**Takeaway:** Always tag explicitly. Untagged = serial = immediate group cap.

## Common Patterns

### The "implement then validate" pattern
```markdown
- [ ] (P) Implement feature X
- [ ] (P) Implement feature Y
- [ ] (I) Run tests
```
Best for: independent features that need a shared validation gate.

### The "foundation then consumers" pattern
```markdown
- [ ] (S) Create shared utility/interface
- [ ] (P) Consumer A uses the utility
- [ ] (P) Consumer B uses the utility
- [ ] (I) Run tests
```
Best for: creating something that multiple subsequent tasks depend on.

### The "phased rollout" pattern
```markdown
- [ ] (P) Phase 1 task A
- [ ] (P) Phase 1 task B
- [ ] (I) Verify phase 1
- [ ] (P) Phase 2 task A (depends on phase 1)
- [ ] (P) Phase 2 task B (depends on phase 1)
- [ ] (I) Verify phase 2
```
Best for: large changes that need intermediate verification.

### The "all parallel" pattern
```markdown
- [ ] (P) Independent change A
- [ ] (P) Independent change B
- [ ] (P) Independent change C
- [ ] (I) Run tests
```
Best for: maximum throughput when all tasks are truly independent.

## Troubleshooting

| Symptom | Likely cause | Diagnostic | Fix |
|---|---|---|---|
| Task reads a file that doesn't exist | Task should be `(S)` not `(P)` — it ran before the task that creates the file | Check which prior task creates the file | Move the dependent task after its prerequisite with `(S)` |
| File has conflicts or garbled content | Two `(P)` tasks in the same group wrote to the same file | Check task descriptions for shared file targets | Make one task `(S)` after the other |
| Tasks run slower than expected | Too many `(S)` tags killing parallelism | Count `(P)` vs `(S)` tags — most tasks should be `(P)` | Audit each `(S)` for genuine dependency |
| Isolated task fails | Prior parallel tasks didn't complete correctly | Check logs for failures in the preceding group | Fix the failing task; `(I)` correctly waited for it |
| Wrong execution order | Misunderstanding of how `(S)` caps groups | Use `--dry-run` to preview grouping | Reorder tasks and re-tag |
