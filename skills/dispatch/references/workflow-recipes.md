# Workflow Recipes

Common dispatch workflows. All async tools require polling — see SKILL.md for the polling pattern.

## Single Issue — Full Pipeline

```
# 1. Generate spec
rid_spec = spec_generate({ issues: "42" })
poll spec_run_status({ runId: rid_spec }) until completed

# 2. Review the spec (optional but recommended)
spec_list({})
spec_read({ file: "42-my-issue.md" })

# 3. Preview tasks (optional but recommended for unfamiliar specs)
dispatch_dry_run({ issueIds: ["42"] })

# 4. Execute
rid_run = dispatch_run({ issueIds: ["42"] })
poll status_get({ runId: rid_run }) until completed
```

## Multiple Independent Issues

```
# Spec all at once (safe — no dependencies between them)
rid_spec = spec_generate({ issues: "42,43,44" })
poll spec_run_status({ runId: rid_spec }) until completed

# Execute concurrently
rid_run = dispatch_run({ issueIds: ["42", "43", "44"], concurrency: 3 })
poll status_get({ runId: rid_run }) until completed
```

## Dependent Issue Chain

```
# Layer 0 — no dependencies
rid_s0 = spec_generate({ issues: "42" })
poll spec_run_status({ runId: rid_s0 }) until completed
rid_r0 = dispatch_run({ issueIds: ["42"] })
poll status_get({ runId: rid_r0 }) until completed

# Layer 1 — safe now that #42 is implemented and its code exists
rid_s1 = spec_generate({ issues: "43" })
poll spec_run_status({ runId: rid_s1 }) until completed
rid_r1 = dispatch_run({ issueIds: ["43"] })
poll status_get({ runId: rid_r1 }) until completed
```

## Regenerate a Spec (Respec)

```
# Call spec_generate again — it overwrites the existing spec file
rid = spec_generate({ issues: "42" })
poll spec_run_status({ runId: rid }) until completed
```

Use this when prerequisite code has changed or the original spec was generated too early.

## Skip Planning (Simple Tasks)

```
rid = dispatch_run({ issueIds: ["42"], noPlan: true })
poll status_get({ runId: rid }) until completed
```

Good for: typo fixes, config changes, adding a single obvious field.

## From Inline Description (No Issue)

```
rid = spec_generate({ issues: "add dark mode toggle to settings page" })
poll spec_run_status({ runId: rid }) until completed
# then dispatch as normal
```

## Retry Failed Tasks

```
# Inspect the failure
status = status_get({ runId: "abc-123" })

# Retry all failures in the run
rid_retry = run_retry({ runId: "abc-123" })
poll status_get({ runId: rid_retry }) until completed

# Or retry a single specific task
rid_task = task_retry({ runId: "abc-123", taskId: "42:3" })
poll status_get({ runId: rid_task }) until completed
```

## Check Recent Activity

```
runs_list({})                        # all recent dispatch runs
runs_list({ status: "failed" })      # only failures
runs_list({ status: "running" })     # currently in-progress
spec_runs_list({})                   # recent spec generation runs
```

## Feature Branch (Group Multiple Issues into One PR)

Run dispatch with `--feature` via the CLI, or dispatch issues sequentially and they'll be grouped if you use a shared branch. Consult the Dispatch README for the `--feature` flag usage.
