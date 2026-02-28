# Organize Tests into src/tests/

> Move all test files from the flat `src/` directory into a dedicated `src/tests/` subdirectory to separate test code from production source modules and improve project navigability.

## Context

Dispatch is a TypeScript CLI tool built with tsup and tested with Vitest v4.0.18. The project uses ESM (`"type": "module"`) with Node.js >= 18. There is no vitest config file — Vitest runs with defaults, auto-discovering `*.test.ts` files anywhere under `src/`.

Currently, four test files live alongside their corresponding source modules directly in `src/`:

- `src/parser.test.ts` — tests for `src/parser.ts` (995 lines)
- `src/config.test.ts` — tests for `src/config.ts` (405 lines)
- `src/spec-generator.test.ts` — tests for `src/spec-generator.ts` (641 lines)
- `src/format.test.ts` — tests for `src/format.ts` (34 lines)

All test files import from their source modules using relative paths with `.js` extensions (the ESM convention for TypeScript projects), e.g., `import { elapsed } from "./format.js"`. There are no path aliases configured in `tsconfig.json`.

The `tsconfig.json` includes all of `src/` and does not exclude test files. The build tool (`tsup`) uses a single entry point (`src/cli.ts`) so test files are not bundled into the dist output regardless of their location.

Key directories and files involved: `src/`, `tsconfig.json`, `tsup.config.ts`, `package.json`.

## Why

Co-locating test files with source modules in the same flat directory creates clutter as the project grows. The `src/` directory currently has 13 source modules plus 4 test files plus 3 subdirectories — the test files add noise when navigating production code. Moving tests into a dedicated `src/tests/` directory provides:

1. **Cleaner separation** — production modules and test modules are visually and structurally distinct.
2. **Easier discoverability** — all tests live in one place, making it obvious which modules have coverage and which do not.
3. **Consistent convention** — establishes a clear pattern for where new tests should be placed as the project grows.

## Approach

Create a `src/tests/` directory and move all four `*.test.ts` files into it, preserving their filenames. Update the relative import paths in each moved test file to point up one directory level (from `"./module.js"` to `"../module.js"`). Since Vitest auto-discovers `*.test.ts` files recursively under `src/`, no test runner configuration changes are needed.

Verify that no other files in the codebase import from the test files (test files should only be consumers, not producers). If any vitest configuration is needed to ensure the new location is discovered, add a minimal `vitest.config.ts` — but this should not be necessary given Vitest's default glob patterns.

After the move, run `vitest run` to confirm all tests still pass and `tsc --noEmit` to confirm type-checking succeeds.

## Integration Points

- **Vitest test discovery:** Vitest's default include pattern (`**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}`) will automatically find tests in `src/tests/`. No config changes should be required.
- **TypeScript compilation:** `tsconfig.json` includes all of `src/`, so `src/tests/` will be included automatically. No changes needed.
- **tsup build:** The bundler entry point is `src/cli.ts` — test files are not bundled. No changes needed.
- **Import paths:** All test files use relative imports with `.js` extensions (ESM convention). After moving one directory deeper, all imports from source modules must be updated from `"./X.js"` to `"../X.js"`. Imports from `node:` built-in modules and `vitest` are unaffected.
- **npm scripts:** `"test": "vitest run"` and `"test:watch": "vitest"` require no changes.
- **CI/build pipeline:** No `.github/workflows` or CI config files were found, but if any exist they should continue to work since the npm test script is unchanged.

## Tasks

- [x] (P) Create the `src/tests/` directory and move `src/parser.test.ts`, `src/config.test.ts`, `src/spec-generator.test.ts`, and `src/format.test.ts` into it, preserving their filenames. Update all relative import paths in each file from `"./module.js"` to `"../module.js"` to reflect the new directory depth. Commit with message: `refactor: move test files into src/tests/ directory`.
- [x] (S) Run `vitest run` to verify all tests pass and `tsc --noEmit` to verify type-checking succeeds from the new location. If any failures occur, fix the import paths or configuration as needed and amend the commit.

## References

- Vitest test file discovery: https://vitest.dev/config/#include
- TypeScript module resolution with `.js` extensions in ESM: https://www.typescriptlang.org/docs/handbook/modules/theory.html#typescript-imitates-the-hosts-module-resolution-but-with-types
