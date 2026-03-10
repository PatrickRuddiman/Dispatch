import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";

vi.mock("../helpers/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    task: vi.fn(),
    verbose: false,
    formatErrorChain: vi.fn().mockReturnValue(""),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

vi.mock("../providers/index.js", () => ({
  PROVIDER_NAMES: ["opencode", "copilot"],
}));

vi.mock("../datasources/index.js", () => ({
  DATASOURCE_NAMES: ["github", "azdevops", "md"],
}));

vi.mock("../config.js", () => ({
  handleConfigCommand: vi.fn(),
  CONFIG_BOUNDS: {
    testTimeout: { min: 1, max: 120 },
    planTimeout: { min: 1, max: 120 },
    concurrency: { min: 1, max: 64 },
  },
}));

vi.mock("../helpers/cleanup.js", () => ({
  runCleanup: vi.fn(),
  registerCleanup: vi.fn(),
}));

vi.mock("../orchestrator/runner.js", () => ({
  boot: vi.fn().mockReturnValue(new Promise(() => {})),
}));

// Suppress Commander.js stdout/stderr output during tests
vi.spyOn(process.stdout, "write").mockImplementation(() => true);
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

import { parseArgs, MAX_CONCURRENCY, HELP, CLI_OPTIONS_MAP } from "../cli.js";

describe("parseArgs --respec", () => {
  it("sets respec to an empty array when --respec is passed with no arguments", () => {
    const [args, flags] = parseArgs(["--respec"]);
    expect(args.respec).toEqual([]);
    expect(flags.has("respec")).toBe(true);
  });

  it("sets respec to a string when --respec is followed by a single issue number", () => {
    const [args, flags] = parseArgs(["--respec", "42"]);
    expect(args.respec).toBe("42");
    expect(flags.has("respec")).toBe(true);
  });

  it("sets respec to a string for comma-separated issue numbers", () => {
    const [args, flags] = parseArgs(["--respec", "1,2,3"]);
    expect(args.respec).toBe("1,2,3");
    expect(flags.has("respec")).toBe(true);
  });

  it("sets respec to a string when --respec is followed by a glob pattern", () => {
    const [args, flags] = parseArgs(["--respec", "specs/*.md"]);
    expect(args.respec).toBe("specs/*.md");
    expect(flags.has("respec")).toBe(true);
  });

  it("sets respec to an array when --respec is followed by multiple arguments", () => {
    const [args, flags] = parseArgs(["--respec", "42", "43", "44"]);
    expect(args.respec).toEqual(["42", "43", "44"]);
    expect(flags.has("respec")).toBe(true);
  });

  it("stops consuming arguments at the next --flag", () => {
    const [args] = parseArgs(["--respec", "42", "--verbose"]);
    expect(args.respec).toBe("42");
    expect(args.verbose).toBe(true);
  });

  it("leaves respec undefined when --respec is not provided", () => {
    const [args, flags] = parseArgs([]);
    expect(args.respec).toBeUndefined();
    expect(flags.has("respec")).toBe(false);
  });

  it("sets respec to an empty array when --respec is immediately followed by another flag", () => {
    const [args] = parseArgs(["--respec", "--verbose"]);
    expect(args.respec).toEqual([]);
    expect(args.verbose).toBe(true);
  });
});

describe("parseArgs --spec and --respec mutual exclusion", () => {
  it("allows both --spec and --respec to be set (mutual exclusion is enforced by orchestrator)", () => {
    const [args, flags] = parseArgs(["--spec", "1,2", "--respec", "3,4"]);
    expect(args.spec).toBe("1,2");
    expect(args.respec).toBe("3,4");
    expect(flags.has("spec")).toBe(true);
    expect(flags.has("respec")).toBe(true);
  });

  it("does not set spec when only --respec is provided", () => {
    const [args] = parseArgs(["--respec", "42"]);
    expect(args.respec).toBe("42");
    expect(args.spec).toBeUndefined();
  });

  it("does not set respec when only --spec is provided", () => {
    const [args] = parseArgs(["--spec", "42"]);
    expect(args.spec).toBe("42");
    expect(args.respec).toBeUndefined();
  });
});

describe("parseArgs --respec with other flags", () => {
  it("combines --respec with --source correctly", () => {
    const [args] = parseArgs(["--respec", "42", "--source", "github"]);
    expect(args.respec).toBe("42");
    expect(args.issueSource).toBe("github");
  });

  it("combines --respec with --provider correctly", () => {
    const [args] = parseArgs(["--respec", "--provider", "copilot"]);
    expect(args.respec).toEqual([]);
    expect(args.provider).toBe("copilot");
  });

  it("collects multiple file paths as an array", () => {
    const [args] = parseArgs(["--respec", "specs/a.md", "specs/b.md"]);
    expect(args.respec).toEqual(["specs/a.md", "specs/b.md"]);
  });
});

describe("parseArgs --fix-tests", () => {
  it("sets fixTests to true when --fix-tests is passed", () => {
    const [args, flags] = parseArgs(["--fix-tests"]);
    expect(args.fixTests).toBe(true);
    expect(flags.has("fixTests")).toBe(true);
  });

  it("leaves fixTests undefined when --fix-tests is not provided", () => {
    const [args, flags] = parseArgs([]);
    expect(args.fixTests).toBeUndefined();
    expect(flags.has("fixTests")).toBe(false);
  });

  it("combines --fix-tests with --verbose correctly", () => {
    const [args] = parseArgs(["--fix-tests", "--verbose"]);
    expect(args.fixTests).toBe(true);
    expect(args.verbose).toBe(true);
  });

  it("combines --fix-tests with --provider correctly", () => {
    const [args] = parseArgs(["--fix-tests", "--provider", "copilot"]);
    expect(args.fixTests).toBe(true);
    expect(args.provider).toBe("copilot");
  });

  it("combines --fix-tests with --dry-run correctly", () => {
    const [args] = parseArgs(["--fix-tests", "--dry-run"]);
    expect(args.fixTests).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it("combines --fix-tests with positional issue IDs", () => {
    const [args, flags] = parseArgs(["--fix-tests", "14", "15"]);
    expect(args.fixTests).toBe(true);
    expect(args.issueIds).toEqual(["14", "15"]);
    expect(flags.has("fixTests")).toBe(true);
  });

  it("combines --fix-tests with a single positional issue ID", () => {
    const [args] = parseArgs(["--fix-tests", "42"]);
    expect(args.fixTests).toBe(true);
    expect(args.issueIds).toEqual(["42"]);
  });

  it("combines --fix-tests with positional issue IDs and --verbose", () => {
    const [args] = parseArgs(["--fix-tests", "14", "15", "--verbose"]);
    expect(args.fixTests).toBe(true);
    expect(args.issueIds).toEqual(["14", "15"]);
    expect(args.verbose).toBe(true);
  });
});

describe("parseArgs --fix-tests mutual exclusion (at parser level)", () => {
  it("allows --fix-tests and --spec to both be set (mutual exclusion is enforced by orchestrator)", () => {
    const [args, flags] = parseArgs(["--fix-tests", "--spec", "42"]);
    expect(args.fixTests).toBe(true);
    expect(args.spec).toBe("42");
    expect(flags.has("fixTests")).toBe(true);
    expect(flags.has("spec")).toBe(true);
  });

  it("allows --fix-tests and --respec to both be set (mutual exclusion is enforced by orchestrator)", () => {
    const [args, flags] = parseArgs(["--fix-tests", "--respec", "42"]);
    expect(args.fixTests).toBe(true);
    expect(args.respec).toBe("42");
    expect(flags.has("fixTests")).toBe(true);
    expect(flags.has("respec")).toBe(true);
  });

  it("does not set fixTests when only --spec is provided", () => {
    const [args] = parseArgs(["--spec", "42"]);
    expect(args.fixTests).toBeUndefined();
  });

  it("does not set fixTests when only positional issue IDs are provided", () => {
    const [args] = parseArgs(["42"]);
    expect(args.fixTests).toBeUndefined();
    expect(args.issueIds).toContain("42");
  });
});

describe("parseArgs --force", () => {
  it("sets force to true when --force is passed", () => {
    const [args, flags] = parseArgs(["--force"]);
    expect(args.force).toBe(true);
    expect(flags.has("force")).toBe(true);
  });

  it("defaults force to false when --force is not provided", () => {
    const [args, flags] = parseArgs([]);
    expect(args.force).toBe(false);
    expect(flags.has("force")).toBe(false);
  });
});

describe("parseArgs --feature", () => {
  it("sets feature to true when --feature is passed", () => {
    const [args, flags] = parseArgs(["--feature"]);
    expect(args.feature).toBe(true);
    expect(flags.has("feature")).toBe(true);
  });

  it("sets feature to the string value when --feature is followed by a name", () => {
    const [args, flags] = parseArgs(["--feature", "my-branch"]);
    expect(args.feature).toBe("my-branch");
    expect(flags.has("feature")).toBe(true);
  });

  it("leaves feature undefined when --feature is not provided", () => {
    const [args, flags] = parseArgs([]);
    expect(args.feature).toBeUndefined();
    expect(flags.has("feature")).toBe(false);
  });

  it("combines --feature with --verbose correctly", () => {
    const [args] = parseArgs(["--feature", "--verbose"]);
    expect(args.feature).toBe(true);
    expect(args.verbose).toBe(true);
  });

  it("combines --feature with --provider correctly", () => {
    const [args] = parseArgs(["--feature", "--provider", "copilot"]);
    expect(args.feature).toBe(true);
    expect(args.provider).toBe("copilot");
  });

  it("combines --feature with --dry-run correctly", () => {
    const [args] = parseArgs(["--feature", "--dry-run"]);
    expect(args.feature).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it("preserves string value when --feature is followed by a name and --verbose", () => {
    const [args] = parseArgs(["--feature", "my-branch", "--verbose"]);
    expect(args.feature).toBe("my-branch");
    expect(args.verbose).toBe(true);
  });

  it("preserves string value when --feature is followed by a name and --dry-run", () => {
    const [args] = parseArgs(["--feature", "my-branch", "--dry-run"]);
    expect(args.feature).toBe("my-branch");
    expect(args.dryRun).toBe(true);
  });

  it("preserves string value when --feature is followed by a name and --provider", () => {
    const [args] = parseArgs(["--feature", "my-branch", "--provider", "copilot"]);
    expect(args.feature).toBe("my-branch");
    expect(args.provider).toBe("copilot");
  });
});

describe("parseArgs --feature mutual exclusion (at parser level)", () => {
  it("allows --feature and --no-branch to both be set (mutual exclusion is enforced by orchestrator)", () => {
    const [args, flags] = parseArgs(["--feature", "--no-branch"]);
    expect(args.feature).toBe(true);
    expect(args.noBranch).toBe(true);
    expect(flags.has("feature")).toBe(true);
    expect(flags.has("noBranch")).toBe(true);
  });

  it("allows --feature and --spec to both be set (mutual exclusion is enforced by orchestrator)", () => {
    const [args, flags] = parseArgs(["--feature", "--spec", "42"]);
    expect(args.feature).toBe(true);
    expect(args.spec).toBe("42");
    expect(flags.has("feature")).toBe(true);
    expect(flags.has("spec")).toBe(true);
  });

  it("allows --feature with a name and --spec to both be set", () => {
    const [args, flags] = parseArgs(["--feature", "my-branch", "--spec", "42"]);
    expect(args.feature).toBe("my-branch");
    expect(args.spec).toBe("42");
    expect(flags.has("feature")).toBe(true);
    expect(flags.has("spec")).toBe(true);
  });

  it("does not set feature when only positional issue IDs are provided", () => {
    const [args] = parseArgs(["42"]);
    expect(args.feature).toBeUndefined();
    expect(args.issueIds).toContain("42");
  });
});

// ─── parseArgs basic flags ──────────────────────────────────────────

describe("parseArgs basic flags", () => {
  it("parses --help", () => {
    const [args, flags] = parseArgs(["--help"]);
    expect(args.help).toBe(true);
    expect(flags.has("help")).toBe(true);
  });

  it("parses -h", () => {
    const [args] = parseArgs(["-h"]);
    expect(args.help).toBe(true);
  });

  it("parses --version", () => {
    const [args, flags] = parseArgs(["--version"]);
    expect(args.version).toBe(true);
    expect(flags.has("version")).toBe(true);
  });

  it("parses -v", () => {
    const [args] = parseArgs(["-v"]);
    expect(args.version).toBe(true);
  });

  it("parses --dry-run", () => {
    const [args, flags] = parseArgs(["--dry-run"]);
    expect(args.dryRun).toBe(true);
    expect(flags.has("dryRun")).toBe(true);
  });

  it("parses --no-plan", () => {
    const [args, flags] = parseArgs(["--no-plan"]);
    expect(args.noPlan).toBe(true);
    expect(flags.has("noPlan")).toBe(true);
  });

  it("parses --no-branch", () => {
    const [args, flags] = parseArgs(["--no-branch"]);
    expect(args.noBranch).toBe(true);
    expect(flags.has("noBranch")).toBe(true);
  });

  it("parses --no-worktree", () => {
    const [args, flags] = parseArgs(["--no-worktree"]);
    expect(args.noWorktree).toBe(true);
    expect(flags.has("noWorktree")).toBe(true);
  });

  it("parses --verbose", () => {
    const [args, flags] = parseArgs(["--verbose"]);
    expect(args.verbose).toBe(true);
    expect(flags.has("verbose")).toBe(true);
  });
});

// ─── parseArgs value flags ──────────────────────────────────────────

describe("parseArgs value flags", () => {
  it("parses --source github", () => {
    const [args, flags] = parseArgs(["--source", "github"]);
    expect(args.issueSource).toBe("github");
    expect(flags.has("issueSource")).toBe(true);
  });

  it("parses --source azdevops", () => {
    const [args] = parseArgs(["--source", "azdevops"]);
    expect(args.issueSource).toBe("azdevops");
  });

  it("parses --org <url>", () => {
    const [args, flags] = parseArgs(["--org", "https://dev.azure.com/myorg"]);
    expect(args.org).toBe("https://dev.azure.com/myorg");
    expect(flags.has("org")).toBe(true);
  });

  it("parses --project <name>", () => {
    const [args, flags] = parseArgs(["--project", "MyProject"]);
    expect(args.project).toBe("MyProject");
    expect(flags.has("project")).toBe(true);
  });

  it("parses --output-dir <dir>", () => {
    const [args, flags] = parseArgs(["--output-dir", "/tmp/out"]);
    expect(args.outputDir).toContain(join("tmp", "out"));
    expect(flags.has("outputDir")).toBe(true);
  });

  it("parses --concurrency <n>", () => {
    const [args, flags] = parseArgs(["--concurrency", "4"]);
    expect(args.concurrency).toBe(4);
    expect(flags.has("concurrency")).toBe(true);
  });

  it("parses --concurrency at MAX_CONCURRENCY boundary", () => {
    const [args, flags] = parseArgs(["--concurrency", String(MAX_CONCURRENCY)]);
    expect(args.concurrency).toBe(MAX_CONCURRENCY);
    expect(flags.has("concurrency")).toBe(true);
  });

  it("parses --provider opencode", () => {
    const [args, flags] = parseArgs(["--provider", "opencode"]);
    expect(args.provider).toBe("opencode");
    expect(flags.has("provider")).toBe(true);
  });

  it("parses --provider copilot", () => {
    const [args] = parseArgs(["--provider", "copilot"]);
    expect(args.provider).toBe("copilot");
  });

  it("parses --server-url <url>", () => {
    const [args, flags] = parseArgs(["--server-url", "http://localhost:3000"]);
    expect(args.serverUrl).toBe("http://localhost:3000");
    expect(flags.has("serverUrl")).toBe(true);
  });

  it("parses --plan-timeout <n>", () => {
    const [args, flags] = parseArgs(["--plan-timeout", "5"]);
    expect(args.planTimeout).toBe(5);
    expect(flags.has("planTimeout")).toBe(true);
  });

  it("parses --plan-timeout with decimal", () => {
    const [args] = parseArgs(["--plan-timeout", "1.5"]);
    expect(args.planTimeout).toBe(1.5);
  });

  it("parses --test-timeout <n>", () => {
    const [args, flags] = parseArgs(["--test-timeout", "5"]);
    expect(args.testTimeout).toBe(5);
    expect(flags.has("testTimeout")).toBe(true);
  });

  it("parses --test-timeout with decimal", () => {
    const [args] = parseArgs(["--test-timeout", "1.5"]);
    expect(args.testTimeout).toBe(1.5);
  });

  it("parses --plan-retries <n>", () => {
    const [args, flags] = parseArgs(["--plan-retries", "3"]);
    expect(args.planRetries).toBe(3);
    expect(flags.has("planRetries")).toBe(true);
  });

  it("parses --plan-retries 0", () => {
    const [args] = parseArgs(["--plan-retries", "0"]);
    expect(args.planRetries).toBe(0);
  });

  it("parses --retries <n>", () => {
    const [args, flags] = parseArgs(["--retries", "3"]);
    expect(args.retries).toBe(3);
    expect(flags.has("retries")).toBe(true);
  });

  it("parses --retries 0", () => {
    const [args] = parseArgs(["--retries", "0"]);
    expect(args.retries).toBe(0);
  });

  it("parses --cwd <dir>", () => {
    const [args, flags] = parseArgs(["--cwd", "/tmp/work"]);
    expect(args.cwd).toContain(join("tmp", "work"));
    expect(flags.has("cwd")).toBe(true);
  });

  it("parses positional issue IDs", () => {
    const [args] = parseArgs(["14", "15", "16"]);
    expect(args.issueIds).toEqual(["14", "15", "16"]);
  });
});

// ─── parseArgs error cases ──────────────────────────────────────────

describe("parseArgs error cases", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  afterEach(() => {
    mockExit.mockClear();
  });

  it("exits for invalid --source", () => {
    expect(() => parseArgs(["--source", "invalid"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for invalid --provider", () => {
    expect(() => parseArgs(["--provider", "invalid"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-positive --concurrency", () => {
    expect(() => parseArgs(["--concurrency", "-1"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --concurrency", () => {
    expect(() => parseArgs(["--concurrency", "abc"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for --concurrency exceeding MAX_CONCURRENCY", () => {
    expect(() => parseArgs(["--concurrency", String(MAX_CONCURRENCY + 1)])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for very large --concurrency value", () => {
    expect(() => parseArgs(["--concurrency", "10000"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-positive --plan-timeout", () => {
    expect(() => parseArgs(["--plan-timeout", "0"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --plan-timeout", () => {
    expect(() => parseArgs(["--plan-timeout", "abc"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for --plan-timeout exceeding maximum", () => {
    expect(() => parseArgs(["--plan-timeout", "121"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-positive --test-timeout", () => {
    expect(() => parseArgs(["--test-timeout", "0"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --test-timeout", () => {
    expect(() => parseArgs(["--test-timeout", "abc"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for negative --test-timeout", () => {
    expect(() => parseArgs(["--test-timeout", "-1"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for negative --plan-retries", () => {
    expect(() => parseArgs(["--plan-retries", "-1"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --plan-retries", () => {
    expect(() => parseArgs(["--plan-retries", "abc"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for negative --retries", () => {
    expect(() => parseArgs(["--retries", "-1"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --retries", () => {
    expect(() => parseArgs(["--retries", "abc"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for unknown flag", () => {
    expect(() => parseArgs(["--unknown-flag"])).toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// ─── Help text completeness ─────────────────────────────────────────
//
// These tests cross-reference the HELP string (shown by `dispatch -h`)
// against CLI_OPTIONS_MAP (the definitive list of Commander options).
// They fail when a flag is added to the parser but not documented, or
// when the help text references a flag that doesn't exist in the parser.

describe("help text completeness", () => {
  /**
   * Convert a Commander camelCase attribute name to its --kebab-case CLI flag.
   *
   * Commander derives attribute names from flags as follows:
   *   --dry-run        → dryRun
   *   --no-plan        → plan      (negated boolean, Commander strips "no-")
   *   --no-branch      → branch
   *   --no-worktree    → worktree
   *   --fix-tests      → fixTests
   *   --server-url     → serverUrl
   *   --plan-timeout   → planTimeout
   *   --plan-retries   → planRetries
   *   --test-timeout   → testTimeout
   *   --output-dir     → outputDir
   *
   * For the negated options (plan, branch, worktree), the CLI flag form is
   * --no-plan, --no-branch, --no-worktree respectively.
   */
  const NEGATED_OPTIONS = new Set(["plan", "branch", "worktree"]);

  function toCliFlag(commanderAttr: string): string {
    const kebab = commanderAttr.replace(/([A-Z])/g, "-$1").toLowerCase();
    if (NEGATED_OPTIONS.has(commanderAttr)) {
      return `--no-${kebab}`;
    }
    return `--${kebab}`;
  }

  /**
   * Extract the options/definition portion of the HELP text — everything
   * before the "Examples:" section. This avoids false positives from flags
   * used as example arguments (e.g. `dispatch 14 --provider copilot`).
   */
  function getHelpDefinitionSection(): string {
    const examplesIdx = HELP.indexOf("Examples:");
    return examplesIdx >= 0 ? HELP.slice(0, examplesIdx) : HELP;
  }

  /**
   * Extract all unique --flag-name tokens from the options definition
   * section of the help text. Matches --kebab-case flags including
   * short aliases like -h and -v.
   */
  function extractHelpFlags(section: string): Set<string> {
    const matches = section.match(/--[\w-]+/g) ?? [];
    return new Set(matches);
  }

  // ── Every Commander option must appear in the help text ────────

  it("documents every registered Commander option in the help text", () => {
    const helpSection = getHelpDefinitionSection();
    const missing: string[] = [];

    for (const attr of Object.keys(CLI_OPTIONS_MAP)) {
      const flag = toCliFlag(attr);
      if (!helpSection.includes(flag)) {
        missing.push(`${flag} (Commander attr: ${attr})`);
      }
    }

    expect(missing).toEqual([]);
  });

  // ── Every flag in help text must exist in Commander ────────────

  it("does not document flags that are missing from the Commander parser", () => {
    const helpSection = getHelpDefinitionSection();
    const helpFlags = extractHelpFlags(helpSection);

    // Build the set of valid CLI flags from CLI_OPTIONS_MAP
    const registeredFlags = new Set<string>();
    for (const attr of Object.keys(CLI_OPTIONS_MAP)) {
      registeredFlags.add(toCliFlag(attr));
    }

    const extra: string[] = [];
    for (const flag of helpFlags) {
      if (!registeredFlags.has(flag)) {
        extra.push(flag);
      }
    }

    expect(extra).toEqual([]);
  });

  // ── No duplicate flag definitions in help text ────────────────

  it("does not define any flag more than once in the options sections", () => {
    const helpSection = getHelpDefinitionSection();

    // Match lines that define an option: leading whitespace + --flag
    // (this avoids counting flags referenced in prose descriptions)
    const definitionLines = helpSection
      .split("\n")
      .filter((line) => /^\s+--[\w-]/.test(line));

    const flagCounts = new Map<string, number>();
    for (const line of definitionLines) {
      // Extract the primary flag from the start of the definition line
      const match = line.match(/^\s+(--[\w-]+)/);
      if (match) {
        const flag = match[1];
        flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
      }
    }

    const duplicates: string[] = [];
    for (const [flag, count] of flagCounts) {
      if (count > 1) {
        duplicates.push(`${flag} (defined ${count} times)`);
      }
    }

    expect(duplicates).toEqual([]);
  });

  // ── Short aliases documented in help match Commander ──────────

  it("documents short aliases (-h, -v) that match their Commander definitions", () => {
    const helpSection = getHelpDefinitionSection();

    // -h should be documented alongside --help
    expect(helpSection).toMatch(/-h,\s*--help/);
    // -v should be documented alongside --version
    expect(helpSection).toMatch(/-v,\s*--version/);
  });
});
