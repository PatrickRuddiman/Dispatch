#!/bin/bash
set -e
WORKTREE="/home/pruddiman/source/repos/Dispatch/.dispatch/worktrees/112-missing-features-progress-persistence-dry-run-for-spec-and-t"

echo "=== Step 1: git status ==="
cd "$WORKTREE"
git status

echo ""
echo "=== Step 2: git add spec files ==="
git add src/spec-generator.ts src/orchestrator/spec-pipeline.ts src/tests/spec-pipeline.test.ts

echo ""
echo "=== Step 3: git commit ==="
git commit -m "test: add spec pipeline dry-run tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

echo ""
echo "=== Step 4: git log ==="
git log --oneline -3
