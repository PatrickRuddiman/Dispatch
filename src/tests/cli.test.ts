import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
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

vi.mock("../cleanup.js", () => ({
  runCleanup: vi.fn(),
  registerCleanup: vi.fn(),
}));

vi.mock("../agents/index.js", () => ({
  bootOrchestrator: vi.fn().mockReturnValue(new Promise(() => {})),
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
