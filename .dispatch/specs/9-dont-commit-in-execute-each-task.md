# Dont commit in execute each task (#9)

> Decouple commit timing from task boundaries so the spec agent controls when commits happen, rather than the orchestrator auto-committing after every single task.

## Context

This is a TypeScript (strict, ESM-only) CLI project built with tsup and tested with Vitest. The dispatch pipeline orchestrates AI agents to implement tasks from markdown spec files. The pipeline flow is: **spec agent** writes task files -> **planner agent** produces per-task plans -> **executor agent** implements each task -> **orchestrator** marks the task complete and commits.

The key modules involved in this change are:

- **`src/agents/orchestrator.ts`** — The core dispatch loop. After each successful task dispatch, the orchestrator calls `markTaskComplete(task)` to check off the markdown checkbox, then calls `commitTask(task, cwd)` to stage all changes and create a conventional commit. The `commitTask` function is imported from `../git.js` and is only used in this file. This auto-commit-per-task behavior is what the issue targets.

- **`src/git.ts`** — Exports `commitTask(task, cwd)` which runs `git add -A`, checks for staged changes, infers a conventional commit type from the task text using a private `buildCommitMessage()` helper, and creates the commit. The conventional commit types it supports are: feat, fix, docs, refactor, test, chore, style, perf, ci. This module requires no changes but its conventions should inform the updated prompts.

- **`src/dispatcher.ts`** — Builds prompts for executor agents. The `buildPrompt()` function (no-plan path) and `buildPlannedPrompt()` function (with-plan path) both contain the hard-coded instruction `"Do NOT commit changes — the orchestrator handles commits."` — in the Instructions list and the Executor Constraints list respectively. These must be updated to conditionally allow commits.

- **`src/agents/planner.ts`** — The planner agent that produces execution plans. Its `buildPlannerPrompt()` function includes `"Do NOT commit changes — the orchestrator handles commits."` in the Constraints subsection of the Output Format section. This must be updated to conditionally include commit steps in plans.

- **`src/spec-generator.ts`** — The `buildSpecPrompt()` function instructs the spec agent to produce markdown task files. It currently provides no guidance about commit strategy. It needs to be extended so the spec agent knows it is responsible for deciding when commits happen and how to express that in task descriptions.

## Why

The current design rigidly couples commit timing to task boundaries — every completed task gets exactly one commit, regardless of whether that makes logical sense. This creates several problems:

1. **No spec-level control** — The spec agent cannot group related changes into a single commit or split a large task into multiple commits. The granularity is fixed at one-commit-per-task.

2. **Noisy git history** — Small, incremental tasks each produce a commit, even when they logically belong together (e.g., "add the interface" and "implement the interface" could be one commit).

3. **Inflexibility** — Some tasks (like "run tests and fix failures") should not produce a commit at all if there are no changes, while others (like a large refactor) might benefit from intermediate commits.

By removing the auto-commit and letting the spec agent embed explicit commit instructions within task descriptions, the system becomes more flexible: the spec agent decides the commit strategy, and the executor agents carry it out.

## Approach

The change follows a **four-part strategy** that migrates commit responsibility from the orchestrator to the spec/executor layer:

1. **Remove the auto-commit call from the orchestrator.** In the task-success path of the dispatch loop in `src/agents/orchestrator.ts`, remove the `commitTask(task, cwd)` call and its import. The `markTaskComplete(task)` call stays — it is markdown bookkeeping, not git. All other orchestrator logic (TUI state tracking, error handling, issue closing, `DispatchSummary` accounting) remains unchanged.

2. **Teach the spec agent about commit strategy.** Extend `buildSpecPrompt()` in `src/spec-generator.ts` to instruct the spec agent that it is responsible for deciding when commits happen. The guidance should tell the spec agent to embed commit instructions within implementation task descriptions (e.g., "Implement X and commit the changes with a conventional commit message") rather than creating standalone `- [ ] Commit` tasks. Standalone commit tasks would fail because each task runs in an isolated agent session that only has access to changes it just made. The prompt should reference the project's conventional commit types (feat, fix, docs, refactor, test, chore, style, perf, ci) so generated specs produce consistent commit messages.

3. **Update executor prompts to conditionally allow commits.** In `src/dispatcher.ts`, replace the blanket "Do NOT commit" instruction in both `buildPrompt()` and `buildPlannedPrompt()` with a conditional instruction: if the task description includes a commit instruction, perform the commit using conventional commit conventions (feat, fix, docs, refactor, test, chore, style, perf, ci); otherwise, do not commit. This makes the executor responsive to what the spec agent specified.

4. **Update the planner prompt similarly.** In `src/agents/planner.ts`, replace the "Do NOT commit" constraint in `buildPlannerPrompt()` with a conditional instruction that tells the planner to include commit steps in its execution plan when the task text specifies committing, and to omit them otherwise.

All changes are prompt-level and control-flow-level — no new modules, interfaces, or dependencies are needed. The `git.ts` module remains unchanged and available for any code that needs programmatic git commits. Executor agents will use git directly via their shell access when instructed to commit by the spec.

## Integration Points

- **`src/agents/orchestrator.ts`** — Remove the `commitTask()` call (line in the task-success `if (result.success)` block) and the `import { commitTask } from "../git.js"` statement. Do not change `markTaskComplete()`, TUI state tracking (`tuiTask.status`, `tuiTask.elapsed`), the `DispatchSummary` counters, the `closeCompletedSpecIssues` logic, or any other orchestrator behavior.

- **`src/dispatcher.ts`** — Modify the `buildPrompt()` and `buildPlannedPrompt()` functions. In each, find the "Do NOT commit" instruction and replace it with a conditional instruction about commits. Maintain the same prompt structure, line-join pattern, and instruction style used throughout these functions.

- **`src/agents/planner.ts`** — Modify `buildPlannerPrompt()` in the Output Format / Constraints section. Replace the "Do NOT commit" line with a conditional instruction. Maintain the same section structure and indentation conventions.

- **`src/spec-generator.ts`** — Extend `buildSpecPrompt()` to add commit strategy guidance. This should be added to the spec template instructions, near the Tasks section or Key Guidelines section where it contextually fits. Must not break the existing spec template structure (the `## Tasks` format, `(P)`/`(S)` tagging instructions, the key guidelines, etc.).

- **`src/git.ts`** — No changes needed. The `commitTask()` export remains available for any future use. The private `buildCommitMessage()` helper defines the project's conventional commit type-inference logic.

- **Conventional commit types** — The updated prompts must reference these types so AI agents produce consistent messages: feat, fix, docs, refactor, test, chore, style, perf, ci. These match the type-inference logic in `git.ts`.

- **Vitest tests** — The existing test suite in `src/parser.test.ts` focuses on markdown parsing and task grouping. No existing tests reference commit behavior, so no tests should break. No new tests are required for this change since it is entirely prompt-text and control-flow changes.

## Tasks

- [ ] (P) Remove the auto-commit from the orchestrator — In `src/agents/orchestrator.ts`, remove the `commitTask(task, cwd)` call from the task-success path and remove the `commitTask` import from `../git.js`. Keep `markTaskComplete(task)` and all other orchestrator logic unchanged. This is the core behavioral change that stops the orchestrator from automatically committing after every task.

- [ ] (P) Update the spec agent prompt to include commit strategy guidance — In `src/spec-generator.ts`, extend `buildSpecPrompt()` to instruct the spec agent that it controls commit timing. The guidance should tell the spec agent to embed commit instructions within implementation task descriptions at logical boundaries rather than creating standalone commit tasks. Reference the conventional commit types (feat, fix, docs, refactor, test, chore, style, perf, ci) so generated specs produce consistent commit messages.

- [x] (P) Update executor prompts to conditionally allow commits — In `src/dispatcher.ts`, replace the hard-coded "Do NOT commit" instruction in both `buildPrompt()` and `buildPlannedPrompt()` with a conditional instruction: if the task description includes a commit instruction, perform the commit using conventional commit conventions; otherwise, do not commit. List the supported conventional commit types in the prompt.

- [ ] (P) Update planner prompt to respect task-level commit instructions — In `src/agents/planner.ts`, replace the "Do NOT commit" constraint in `buildPlannerPrompt()` with a conditional instruction that tells the planner to include commit steps in its execution plan when the task text specifies committing, and to omit commit steps otherwise.

## References

- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/9
- Conventional Commits: https://www.conventionalcommits.org/
- Orchestrator: `src/agents/orchestrator.ts`
- Dispatcher: `src/dispatcher.ts`
- Planner: `src/agents/planner.ts`
- Spec generator: `src/spec-generator.ts`
- Git module: `src/git.ts`
