#!/bin/bash
cd /home/pruddiman/source/repos/Dispatch/.dispatch/worktrees/111-no-timeout-on-npm-test-spawn-in-test-runner-ts
npx vitest run src/tests/test-runner.test.ts src/tests/cli.test.ts
