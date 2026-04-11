# Troubleshooting

## Dispatch / Spec Failures

| Symptom | Cause | Fix |
|---|---|---|
| Spec references code that doesn't exist | Prerequisite issue hasn't been executed | Execute the prerequisite first, then call `spec_generate` again |
| `dispatch_run` tasks fail — "file not found" or "symbol not found" | Task depends on code from a prior issue that isn't done | Execute issues in dependency order; re-spec if needed |
| Spec quality is poor / tasks seem wrong | Spec was generated before prerequisite code existed | Execute prerequisites, then `spec_generate` the issue again |
| Planner times out | Complex task or slow codebase exploration | Pass `planTimeout` (minutes) to `dispatch_run`, or `noPlan: true` for simpler tasks |
| Too slow — everything sequential | Independent issues dispatched one at a time | Identify independent issues and spec/execute with `concurrency` > 1 |
| `spec_run_status` shows `failed` | Spec pipeline error | Check `error` field in status response; re-run `spec_generate` |
| `status_get` shows tasks stuck in `running` | Agent hung | Use `run_retry` to re-run; check logs via logging notifications |
| Dispatched before spec finished | Polling skipped between `spec_generate` and `dispatch_run` | Always poll `spec_run_status` to `completed` before calling `dispatch_run` |

## Task Ordering Issues (Inside Specs)

| Symptom | Likely cause | Fix |
|---|---|---|
| Task reads a file that doesn't exist | Task ran in parallel before the task that creates the file | The task should be `(S)` not `(P)` — report to spec author or regenerate |
| File has conflicts or garbled content | Two `(P)` tasks wrote to the same file concurrently | One task needs to be `(S)` after the other |
| Tasks run slower than expected | Too many `(S)` tags killing parallelism | Audit each `(S)` — most tasks should be `(P)` |
| Isolated task fails | Prior parallel tasks didn't complete correctly | Fix the failing task; `(I)` correctly waited for it |
| Wrong execution order | Misunderstanding of how `(S)` caps groups | Use `dispatch_dry_run` to preview grouping before executing |

## Dependency Order Violations

These produce subtle, hard-to-debug failures. When in doubt, verify with `issues_fetch` and grep/glob the codebase before speccing.

| Scenario | What goes wrong | Correct action |
|---|---|---|
| Specced B before A is executed | B's spec is written against missing code; tasks will fail or be wrong | Execute A fully, then `spec_generate` B |
| Specced A and B together (B depends on A) | B's spec has no A code to reference | Spec them in separate layers |
| Re-specced an issue after its dependency changed | Spec may now be stale | Re-spec again after verifying dependencies exist |
