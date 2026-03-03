import { describe, it, expect, vi, afterEach } from "vitest";

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
}));

vi.mock("../helpers/cleanup.js", () => ({
  runCleanup: vi.fn(),
  registerCleanup: vi.fn(),
}));

vi.mock("../orchestrator/runner.js", () => ({
  boot: vi.fn().mockReturnValue(new Promise(() => {})),
}));

import { parseArgs } from "../cli.js";

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
    expect(args.outputDir).toContain("tmp/out");
    expect(flags.has("outputDir")).toBe(true);
  });

  it("parses --concurrency <n>", () => {
    const [args, flags] = parseArgs(["--concurrency", "4"]);
    expect(args.concurrency).toBe(4);
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

  it("parses --plan-retries <n>", () => {
    const [args, flags] = parseArgs(["--plan-retries", "3"]);
    expect(args.planRetries).toBe(3);
    expect(flags.has("planRetries")).toBe(true);
  });

  it("parses --plan-retries 0", () => {
    const [args] = parseArgs(["--plan-retries", "0"]);
    expect(args.planRetries).toBe(0);
  });

  it("parses --cwd <dir>", () => {
    const [args, flags] = parseArgs(["--cwd", "/tmp/work"]);
    expect(args.cwd).toContain("tmp/work");
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
    expect(() => parseArgs(["--source", "invalid"])).toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for invalid --provider", () => {
    expect(() => parseArgs(["--provider", "invalid"])).toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-positive --concurrency", () => {
    expect(() => parseArgs(["--concurrency", "-1"])).toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --concurrency", () => {
    expect(() => parseArgs(["--concurrency", "abc"])).toThrow("process.exit called");
  });

  it("exits for non-positive --plan-timeout", () => {
    expect(() => parseArgs(["--plan-timeout", "0"])).toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --plan-timeout", () => {
    expect(() => parseArgs(["--plan-timeout", "abc"])).toThrow("process.exit called");
  });

  it("exits for negative --plan-retries", () => {
    expect(() => parseArgs(["--plan-retries", "-1"])).toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits for non-numeric --plan-retries", () => {
    expect(() => parseArgs(["--plan-retries", "abc"])).toThrow("process.exit called");
  });

  it("exits for unknown flag", () => {
    expect(() => parseArgs(["--unknown-flag"])).toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
