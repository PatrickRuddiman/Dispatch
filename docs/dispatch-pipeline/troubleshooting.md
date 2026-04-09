# Troubleshooting

## What it does

This page covers common operational issues encountered when running the
dispatch pipeline, their root causes, and resolution strategies. Each issue
includes the error message or symptom, where in the pipeline it occurs, and
the recommended fix.

## Pipeline Phase Failures

### No work items found

**Symptom:** `No work items found from datasource: {source}` or
`No work items found from issue(s) {ids}`

**Phase:** Discovery (Phase 1)

**Causes:**

- No open issues in the configured datasource.
- Wrong `--source`, `--org`, or `--project` values.
- Issues exist but have no unchecked task lines.
- Glob pattern (md datasource) matches no files.

**Resolution:**

1. Run `dispatch run --dry-run` to verify discovery without executing.
2. Check datasource configuration with `dispatch config`.
3. For GitHub: verify the repo has open issues with checkbox task lists.
4. For md datasource: verify file paths or glob patterns are correct.

### No unchecked tasks found

**Symptom:** `No unchecked tasks found`

**Phase:** Parsing (Phase 2)

**Causes:**

- All tasks in discovered issues are already checked (`- [x]`).
- Issue bodies contain no markdown checkbox syntax (`- [ ]`).
- Task lines are malformed (e.g., missing space after `[ ]`).

**Resolution:**

1. Inspect the issue body for correct checkbox syntax: `- [ ] task text`.
2. Run `dispatch run --dry-run` to see which tasks would be extracted.

### No datasource configured

**Symptom:** `No datasource configured. Use --source or run 'dispatch config'
to set up defaults.`

**Phase:** Discovery (Phase 1)

**Resolution:** Run `dispatch config` to set up a default datasource, or
pass `--source github|azdevops|md` on the command line.

## Branch and Worktree Failures

### Branch creation failed

**Symptom:** `Branch creation failed for issue #{number}: {message}`

**Phase:** Dispatching (Phase 4), inside `processIssueFile()`

**Causes:**

- Branch name collision with an existing branch.
- Git lock contention (`.git/index.lock` exists).
- Invalid characters in the generated branch name.
- Working tree has uncommitted changes that conflict with branch switch.

**Resolution:**

1. Delete stale local branches: `git branch -d dispatch/{user}/{number}-*`.
2. Remove stale lock files: `rm -f .git/index.lock`.
3. Commit or stash any uncommitted changes before running dispatch.

**Pipeline behavior:** All tasks for the affected issue are marked as failed.
Other issues continue processing.

### Worktree creation failed after retries

**Symptom:** Worktree creation errors in logs, followed by task failures.

**Phase:** Dispatching (Phase 4), inside `createWorktree()`

**Causes:**

- Stale worktree references from a previous interrupted run.
- Branch name already checked out in another worktree.
- File system permission issues on `.dispatch/worktrees/`.

**Resolution:**

1. Prune stale worktrees: `git worktree prune`.
2. List current worktrees: `git worktree list`.
3. Remove stale worktree directories: `rm -rf .dispatch/worktrees/`.
4. Delete conflicting branches: `git branch -d {branch-name}`.

The worktree helper retries up to 5 times with exponential backoff
(200ms, 400ms, 800ms, 1600ms, 3200ms). If all retries fail, the issue's
tasks are marked as failed.

See [Worktree Lifecycle](./worktree-lifecycle.md) for retry details.

### Feature branch creation failed

**Symptom:** `Feature branch creation failed: {message}`

**Phase:** Dispatching (Phase 4), feature branch setup

**Causes:**

- Invalid branch name passed to `--feature`.
- Git repository state prevents branch creation.

**Resolution:**

1. Verify the branch name: `--feature` values must pass `isValidBranchName()`.
2. Ensure the repo is in a clean state with no detached HEAD.

**Pipeline behavior:** Immediate pipeline exit with all tasks marked as
failed.

### Feature merge conflict

**Symptom:** `Could not merge {branchName} into feature branch: {message}`

**Phase:** PR Lifecycle (Phase 6), feature mode path

**Causes:**

- Two issues modified the same files in conflicting ways.
- Changes conflict with existing content on the feature branch.

**Resolution:**

1. Inspect the feature branch manually: `git checkout {featureBranchName}`.
2. Resolve conflicts and re-merge the issue branch.
3. Consider splitting conflicting issues into separate feature branches.

**Pipeline behavior:** `git merge --abort` is run to clean up. The issue's
tasks are marked as failed. The pipeline continues with the next issue.

## Provider and Agent Failures

### All providers are throttled or unavailable

**Symptom:** `ProviderPool: all providers are throttled or unavailable`

**Phase:** Dispatching (Phase 4), during planning or execution

**Causes:**

- All configured providers are currently rate-limited.
- Only one provider is configured and it is throttled.
- Cooldown period (60 seconds) has not elapsed.

**Resolution:**

1. Wait for the cooldown to expire and retry.
2. Configure additional fallback providers to improve resilience.
3. Reduce concurrency (`--concurrency 1`) to lower request rates.

**Pipeline behavior:** The task enters the pause/recovery loop. In
interactive mode, the user can wait and select "rerun". In non-TTY mode,
the task fails immediately.

### Planning timed out

**Symptom:** `Planning timed out for task "{text}" (attempt {n}/{max})`

**Phase:** Dispatching (Phase 4), planning step

**Causes:**

- Complex task requiring extensive codebase exploration.
- Slow provider response time.
- Planner stuck in a loop.

**Resolution:**

1. Increase planning timeout: `--plan-timeout 60` (minutes).
2. Increase plan retries: `--plan-retries 5`.
3. Skip planning: `--no-plan` (executor will work without a plan).
4. Simplify the task description.

**Pipeline behavior:** Each timeout triggers a retry (up to
`maxPlanAttempts`). After all attempts, the task enters the pause/recovery
loop.

### Rate limit detected in response text

**Symptom:** `Rate limit: {truncated response text}`

**Phase:** Dispatching (Phase 4), inside `dispatchTask()`

**Causes:**

- The provider returned a 200 response but the body contains rate-limit
  language (e.g., "you've hit your rate limit").
- This is distinct from HTTP-level throttling (429/503), which is handled
  by the provider pool's failover mechanism.

**Resolution:**

1. Wait and retry -- this usually clears after a few minutes.
2. Configure an alternative provider as a fallback.

The dispatcher checks four patterns:

- `you've hit your (rate )?limit`
- `rate limit exceeded`
- `too many requests`
- `quota exceeded`

Source: `src/dispatcher.ts:19-24`.

### Commit agent returned empty response

**Symptom:** `Commit agent failed for issue #{number}: Commit agent returned
empty response`

**Phase:** Commit Generation (Phase 5)

**Causes:**

- Provider returned null or whitespace-only response.
- Provider session expired.

**Resolution:** No action required -- the pipeline falls back to
`buildPrTitle()` and `buildPrBody()` for PR metadata. The branch is pushed
and the PR is created with template-based content.

## PR and Push Failures

### Could not push branch

**Symptom:** `Could not push branch {branchName}: {error}`

**Phase:** PR Lifecycle (Phase 6)

**Causes:**

- No remote configured.
- Authentication failure for the remote.
- Branch already exists on the remote with conflicting history.

**Resolution:**

1. Verify remote exists: `git remote -v`.
2. Check authentication: the pipeline pre-authenticates, but tokens may
   expire during long runs.
3. The branch still exists locally -- push manually with
   `git push origin {branchName}`.

**Pipeline behavior:** Warning logged. PR creation is skipped.

### Could not create PR

**Symptom:** `Could not create PR for issue #{number}: {error}`

**Phase:** PR Lifecycle (Phase 6)

**Causes:**

- API authentication failure.
- PR already exists for the branch.
- Branch not found on the remote (push failed earlier).

**Resolution:**

1. Create the PR manually via the GitHub/Azure DevOps web UI.
2. Verify the branch was pushed: `git log origin/{branchName}`.
3. Check API permissions for PR creation.

**Pipeline behavior:** Warning logged. The pipeline continues. The branch
is already pushed, so the work is not lost.

## Recovery and Debugging

### Task stuck in paused state

**Symptom:** TUI shows a task as "paused" with a recovery prompt.

**Resolution:** Choose an action:

- **Rerun:** Re-executes the task from the planning phase. Useful if the
  failure was transient (provider throttling, network issue).
- **Quit:** Marks the task as failed and halts the pipeline. The branch and
  worktree are preserved for manual inspection.

In non-TTY environments (CI, piped output), the task is immediately marked
as failed without waiting for input.

See [Task Recovery](./task-recovery.md) for the full recovery flow.

### Enabling verbose logging

Pass `--verbose` (or `-v`) to enable detailed logging:

- Console output shows all debug messages instead of TUI rendering.
- Per-issue log files are written to `.dispatch/logs/issue-{id}.log`.
- Log files contain full prompts, responses, phase transitions, and agent
  events.

The log files are invaluable for diagnosing:

- What prompt was sent to the planner/executor/commit agent.
- What the AI responded with.
- Which phase the pipeline was in when a failure occurred.
- Timing information for each phase.

### Inspecting worktree state

When a task fails in worktree mode, the worktree is preserved at
`.dispatch/worktrees/issue-{number}/`. Inspect it:

```bash
# List all worktrees
git worktree list

# Change to the worktree
cd .dispatch/worktrees/issue-123/

# Check the state
git status
git log --oneline

# Clean up when done
cd ../../../
git worktree remove .dispatch/worktrees/issue-123
git worktree prune
```

### Cleaning up after interrupted runs

If the pipeline is interrupted (Ctrl+C, process kill), cleanup handlers may
not run completely. Manual cleanup:

```bash
# Remove all dispatch worktrees
rm -rf .dispatch/worktrees/

# Prune stale git worktree references
git worktree prune

# Switch back to your default branch
git checkout main

# Remove stale dispatch branches
git branch | grep 'dispatch/' | xargs git branch -D

# Remove temp files
rm -rf .dispatch/tmp/
```

The `registerCleanup()` mechanism attempts to run all registered cleanup
functions on process exit (SIGINT, SIGTERM, uncaught exceptions), but
cannot guarantee execution if the process is killed with SIGKILL.

## Cross-References

- [Pipeline Lifecycle](./pipeline-lifecycle.md) -- phase-by-phase pipeline
  flow for understanding where failures occur.
- [Provider Pool and Failover](./provider-pool-and-failover.md) -- throttle
  detection and failover mechanics.
- [Worktree Lifecycle](./worktree-lifecycle.md) -- worktree creation retry
  logic and cleanup.
- [Task Recovery](./task-recovery.md) -- interactive recovery flow.
- [Feature Branch Mode](./feature-branch-mode.md) -- feature-specific
  failure modes.
- [Commit and PR Generation](./commit-and-pr-generation.md) -- commit agent
  fallback behavior.
- [Configuration](../cli-orchestration/configuration.md) -- provider and
  datasource selection, timeout configuration, and the `dispatch config`
  wizard.
- [Provider System](../provider-system/overview.md) -- provider boot,
  session lifecycle, and `--server-url` for debugging provider connectivity
  issues.
- [Logger](../shared-types/logger.md) -- `--verbose` flag behavior and
  console vs. file logger output modes.
- [Cleanup Registry](../shared-types/cleanup.md) -- how `registerCleanup()`
  and `runCleanup()` manage process-level resource cleanup on signal/exit.
- [Dispatch Pipeline Tests](../testing/dispatch-pipeline-tests.md) -- unit
  tests covering the failure modes documented in this troubleshooting guide.
- [Integration & E2E Tests](../testing/tests-integration-e2e.md) -- end-to-end
  tests that exercise retry/recovery and non-interactive failure paths.
