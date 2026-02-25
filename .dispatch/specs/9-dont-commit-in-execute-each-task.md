# Dont commit in execute each task (#9)

> Decouple commit timing from task boundaries so the spec agent can control when commits happen, rather than the orchestrator auto-committing after every single task.

## Context

This is a TypeScript (strict, ESM-only) CLI project built with tsup and tested with Vitest. The dispatch pipeline lives across four key files:

- **`src/agents/orchestrator.ts`** — The core dispatch loop. After each successful task dispatch it calls `markTaskComplete(task)` (to check off the `- [ ]` item in the markdown) then `commitTask(task, cwd)` (to `git add -A && git commit`). This auto-commit-per-task behavior is the focus of the issue.

- **`src/git.ts`** — Exports `commitTask(task, cwd)` which stages all changes, infers a conventional commit type from the task text, and creates a commit. This module also exports the lower-level `buildCommitMessage()` helper. The `commitTask` function is only imported in the orchestrator.

- **`src/dispatcher.ts`** — Builds prompts for executor agents. Both `buildPrompt()` (no-plan path) and `buildPlannedPrompt()` (with-plan path) include the hard-coded instruction `"Do NOT commit changes — the orchestrator handles commits."` in the executor constraints.

- **`src/agents/planner.ts`** — The planner agent that produces execution plans. Its `buildPlannerPrompt()` includes `"Do NOT commit changes — the orchestrator handles commits."` in the output format constraints section.

- **`src/spec-generator.ts`** — The `buildSpecPrompt()` function that instructs the spec agent to produce markdown task files. Currently it gives no guidance about commit strategy within the task list.

The pipeline flow is: **spec agent** writes task files → **planner agent** produces per-task plans → **executor agent** implements each task → **orchestrator** marks complete and commits. The issue proposes shifting commit authority from the orchestrator to the spec/executor layer.

## Why

The current design rigidly couples commit timing to task boundaries — every completed task gets exactly one commit, regardless of whether that makes logical sense. This has several problems:

1. **No spec-level control** — The spec agent cannot group related changes into a single commit or split a large task into multiple commits. The granularity is fixed at one-commit-per-task.

2. **Noisy git history** — Small, incremental tasks each produce a commit, even when they logically belong together (e.g., "add the interface" and "implement the interface" could be one commit).

3. **Inflexibility** — Some tasks (like "run tests and fix failures") shouldn't produce a commit at all if there are no changes, while others (like a large refactor) might benefit from intermediate commits.

By removing the auto-commit and letting the spec agent embed explicit commit points in the task list, the system becomes more flexible: the spec agent decides the commit strategy, and the executor agents carry it out.

## Approach

The change follows a **four-part strategy** that migrates commit responsibility from the orchestrator to the spec/executor layer:

1. **Remove the auto-commit call** from the orchestrator's per-task success path. The `markTaskComplete()` call stays — it's markdown bookkeeping, not git. The `commitTask` import can be removed entirely from orchestrator.ts since it will no longer be used there.

2. **Teach the spec agent** to embed commit points in its task lists. The `buildSpecPrompt()` in spec-generator.ts should instruct the spec agent that it is responsible for deciding when commits happen. Commit instructions should be attached to implementation tasks (e.g., "Implement X and commit the changes") rather than being standalone `- [ ] Commit` tasks, since each task runs in an isolated agent session and can only commit what it just implemented.

3. **Update executor prompts** to conditionally allow commits. Instead of the blanket "Do NOT commit", the prompts in dispatcher.ts should tell the executor: if the task text includes a commit instruction, perform the commit using conventional commit conventions; otherwise, do not commit. This makes the executor responsive to what the spec agent specified.

4. **Update the planner prompt** similarly — remove the blanket "Do NOT commit" constraint and replace it with a conditional instruction that respects commit points embedded in the task text.

The `git.ts` module and its `commitTask()` function remain unchanged — they are still available for any code that needs programmatic git commits, and the executor agents will use git directly (via their shell access) when instructed to commit.

All changes are prompt-level and control-flow-level — no new modules, interfaces, or dependencies are needed. The existing conventional commit conventions (feat, fix, docs, etc.) should be referenced in the updated prompts so executor agents produce consistent commit messages.

## Integration Points

- **`src/agents/orchestrator.ts`** — Remove the `commitTask()` call and its import. Do not change `markTaskComplete()` or the TUI state tracking. The `DispatchSummary`, `OrchestrateRunOptions`, and issue-closing logic are unaffected.

- **`src/dispatcher.ts`** — Modify `buildPrompt()` and `buildPlannedPrompt()` to replace the "Do NOT commit" line with a conditional commit instruction. Must maintain the same prompt structure and conventions.

- **`src/agents/planner.ts`** — Modify `buildPlannerPrompt()` to replace the "Do NOT commit" constraint with a conditional one. Must maintain the same output format section structure.

- **`src/spec-generator.ts`** — Extend `buildSpecPrompt()` to include guidance about commit strategy in the task list. Must not break the existing spec template structure (the `## Tasks` section format, the key guidelines, etc.).

- **`src/git.ts`** — No changes needed. The `commitTask()` export remains available.

- **Conventional commit conventions** — The existing type-inference logic in `git.ts` (`buildCommitMessage`) defines the project's convention (feat, fix, docs, refactor, test, chore, style, perf, ci). Updated prompts should reference these types so AI agents produce consistent messages.

- **Vitest tests** — `src/parser.test.ts` tests the parser, not the orchestrator or prompts. No existing tests should break. If any tests reference the commit behavior, they may need updating, but the current test suite focuses on markdown parsing.

## Tasks

- [ ] Remove the auto-commit from the orchestrator — In `src/agents/orchestrator.ts`, remove the `commitTask(task, cwd)` call from the task-success path and remove the `commitTask` import from `src/git.js`. Keep `markTaskComplete(task)` and all other orchestrator logic unchanged.

- [ ] Update the spec agent prompt to include commit strategy guidance — In `src/spec-generator.ts`, extend `buildSpecPrompt()` to instruct the spec agent that it controls commit timing. The spec agent should embed commit instructions within implementation tasks at logical boundaries rather than creating standalone commit tasks. Reference the project's conventional commit types.

- [ ] Update executor prompts to conditionally allow commits — In `src/dispatcher.ts`, replace the hard-coded "Do NOT commit" instruction in both `buildPrompt()` and `buildPlannedPrompt()` with a conditional instruction: if the task text calls for a commit, perform it using conventional commit conventions; otherwise, do not commit.

- [ ] Update planner prompt to respect task-level commit instructions — In `src/agents/planner.ts`, replace the "Do NOT commit" constraint in `buildPlannerPrompt()` with a conditional instruction that tells the planner to include commit steps in its execution plan when the task specifies committing.

## References

- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/9
- Conventional Commits: https://www.conventionalcommits.org/
- Orchestrator docs: `docs/cli-orchestration/orchestrator.md`
- Dispatcher docs: `docs/planning-and-dispatch/dispatcher.md`
- Planner docs: `docs/planning-and-dispatch/planner.md`
- Git module docs: `docs/planning-and-dispatch/git.md`
- Spec generation docs: `docs/spec-generation/overview.md`
