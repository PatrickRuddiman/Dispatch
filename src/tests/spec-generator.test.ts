import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { isIssueNumbers, isGlobOrFilePath, validateSpecStructure, extractSpecContent, resolveSource } from "../spec-generator.js";
import { buildFileSpecPrompt, boot } from "../agents/spec.js";
import * as datasourcesIndex from "../datasources/index.js";
import type { ProviderInstance, ProviderProgressSnapshot } from "../providers/interface.js";
import type { Datasource, IssueDetails } from "../datasources/interface.js";
import { createMockDatasource } from "./fixtures.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("test-uuid-1234"),
}));

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

vi.mock("glob", () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

vi.mock("../helpers/cleanup.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../providers/index.js", () => ({
  bootProvider: vi.fn(),
  PROVIDER_NAMES: ["opencode", "copilot"],
}));

vi.mock("../helpers/format.js", () => ({
  elapsed: vi.fn().mockReturnValue("0ms"),
  renderHeaderLines: vi.fn().mockReturnValue(["mock-header"]),
}));

import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { log } from "../helpers/logger.js";
import { glob as globFn } from "glob";
import { bootProvider } from "../providers/index.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";

function createMockProvider(overrides?: Partial<ProviderInstance>): ProviderInstance {
  return {
    name: "mock",
    model: "mock-model",
    createSession: vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("session-1"),
    prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done"),
    cleanup: vi.fn<ProviderInstance["cleanup"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("resolveSource", () => {
  const CWD = "/tmp/fake-repo";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Explicit --source flag always wins (unchanged behavior) ---

  it("returns the explicit issueSource when provided with a glob input", async () => {
    const result = await resolveSource("drafts/*.md", "github", CWD);
    expect(result).toBe("github");
  });

  it("returns the explicit issueSource when provided with an azdevops source", async () => {
    const result = await resolveSource("drafts/*.md", "azdevops", CWD);
    expect(result).toBe("azdevops");
  });

  it("returns the explicit issueSource when provided in tracker mode", async () => {
    const result = await resolveSource("1,2,3", "github", CWD);
    expect(result).toBe("github");
  });

  // --- Glob input with no explicit source triggers auto-detection ---

  it("attempts auto-detection when no issueSource is provided and input is a glob", async () => {
    const spy = vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("github");
    const result = await resolveSource("drafts/*.md", undefined, CWD);
    expect(spy).toHaveBeenCalledWith(CWD);
    expect(result).toBe("github");
  });

  it("attempts auto-detection when no issueSource is provided and input is a bare filename", async () => {
    const spy = vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("azdevops");
    const result = await resolveSource("my-spec.md", undefined, CWD);
    expect(spy).toHaveBeenCalledWith(CWD);
    expect(result).toBe("azdevops");
  });

  // --- Glob input falls back to "md" when auto-detection fails ---

  it("falls back to 'md' when no issueSource is provided, input is a glob, and auto-detection returns null", async () => {
    const spy = vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);
    const result = await resolveSource("drafts/*.md", undefined, CWD);
    expect(spy).toHaveBeenCalledWith(CWD);
    expect(result).toBe("md");
  });

  it("falls back to 'md' when no issueSource is provided, input is a bare filename, and auto-detection returns null", async () => {
    const spy = vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);
    const result = await resolveSource("my-spec.md", undefined, CWD);
    expect(spy).toHaveBeenCalledWith(CWD);
    expect(result).toBe("md");
  });

  it("falls back to 'md' for glob input with fake cwd (no git remote)", async () => {
    // No mock — uses real detectDatasource which returns null for /tmp/fake-repo
    const result = await resolveSource("drafts/*.md", undefined, CWD);
    expect(result).toBe("md");
  });

  // --- Glob input still respects explicit --source override ---

  it("returns 'md' when explicitly provided as issueSource with a glob input", async () => {
    const result = await resolveSource("drafts/*.md", "md", CWD);
    expect(result).toBe("md");
  });

  // --- Tracker mode (issue numbers) auto-detection still works ---

  it("attempts auto-detection for issue numbers when no issueSource is provided", async () => {
    const spy = vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("github");
    const result = await resolveSource("1,2,3", undefined, CWD);
    expect(spy).toHaveBeenCalledWith(CWD);
    expect(result).toBe("github");
  });

  it("returns null for issue numbers when auto-detection fails", async () => {
    const spy = vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);
    const result = await resolveSource("1,2,3", undefined, CWD);
    expect(spy).toHaveBeenCalledWith(CWD);
    expect(result).toBeNull();
  });

  it("returns 'md' for an array of file paths when auto-detection returns null", async () => {
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);
    const result = await resolveSource(["/path/to/spec1.md", "/path/to/spec2.md"], undefined, CWD);
    expect(result).toBe("md");
  });
});

describe("isIssueNumbers", () => {
  it("returns true for a single issue number", () => {
    expect(isIssueNumbers("42")).toBe(true);
  });

  it("returns true for comma-separated issue numbers", () => {
    expect(isIssueNumbers("1,2,3")).toBe(true);
  });

  it("returns true for comma-separated numbers with spaces", () => {
    expect(isIssueNumbers("1, 2, 3")).toBe(true);
  });

  it("returns true for two numbers with a space after comma", () => {
    expect(isIssueNumbers("10, 20")).toBe(true);
  });

  it("returns true for a single digit", () => {
    expect(isIssueNumbers("1")).toBe(true);
  });

  it("returns true for large issue numbers", () => {
    expect(isIssueNumbers("12345")).toBe(true);
  });

  it("returns true for many comma-separated numbers", () => {
    expect(isIssueNumbers("1,2,3,4,5,6,7,8,9,10")).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isIssueNumbers("")).toBe(false);
  });

  it("returns false for a glob pattern", () => {
    expect(isIssueNumbers("drafts/*.md")).toBe(false);
  });

  it("returns false for a relative file path", () => {
    expect(isIssueNumbers("./my-spec.md")).toBe(false);
  });

  it("returns false for a bare filename", () => {
    expect(isIssueNumbers("spec.md")).toBe(false);
  });

  it("returns false for a path with directories", () => {
    expect(isIssueNumbers("docs/specs/feature.md")).toBe(false);
  });

  it("returns false for whitespace only", () => {
    expect(isIssueNumbers("   ")).toBe(false);
  });

  it("returns false for a trailing comma", () => {
    expect(isIssueNumbers("1,2,")).toBe(false);
  });

  it("returns false for a leading comma", () => {
    expect(isIssueNumbers(",1,2")).toBe(false);
  });

  it("returns false for double commas", () => {
    expect(isIssueNumbers("1,,2")).toBe(false);
  });

  it("returns false for alphabetic characters mixed with digits", () => {
    expect(isIssueNumbers("1a,2b")).toBe(false);
  });

  it("returns false for a string with only a comma", () => {
    expect(isIssueNumbers(",")).toBe(false);
  });

  it("returns false for a bare wildcard glob pattern", () => {
    expect(isIssueNumbers("*.md")).toBe(false);
  });

  it("returns false for a dot-slash relative path", () => {
    expect(isIssueNumbers("./spec.md")).toBe(false);
  });

  it("returns false for a relative file path in a subdirectory", () => {
    expect(isIssueNumbers("drafts/feature.md")).toBe(false);
  });

  it("returns false for mixed numeric and alphabetic content", () => {
    expect(isIssueNumbers("42,foo")).toBe(false);
  });

  it("returns false for an array of file paths", () => {
    expect(isIssueNumbers(["/path/to/spec1.md", "/path/to/spec2.md"])).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(isIssueNumbers([])).toBe(false);
  });
});

describe("isGlobOrFilePath", () => {
  // --- Glob patterns (true) ---

  it("returns true for a wildcard glob pattern", () => {
    expect(isGlobOrFilePath("*.md")).toBe(true);
  });

  it("returns true for a directory wildcard glob", () => {
    expect(isGlobOrFilePath("drafts/*.md")).toBe(true);
  });

  it("returns true for a double-star recursive glob", () => {
    expect(isGlobOrFilePath("**/*.ts")).toBe(true);
  });

  it("returns true for a question mark glob", () => {
    expect(isGlobOrFilePath("file?.txt")).toBe(true);
  });

  it("returns true for a bracket glob pattern", () => {
    expect(isGlobOrFilePath("file[0-9].md")).toBe(true);
  });

  it("returns true for a brace expansion glob", () => {
    expect(isGlobOrFilePath("*.{md,txt}")).toBe(true);
  });

  // --- File paths (true) ---

  it("returns true for a relative file path with directory", () => {
    expect(isGlobOrFilePath("drafts/feature.md")).toBe(true);
  });

  it("returns true for a dot-slash relative path", () => {
    expect(isGlobOrFilePath("./my-spec.md")).toBe(true);
  });

  it("returns true for a dot-dot relative path", () => {
    expect(isGlobOrFilePath("../specs/feature.md")).toBe(true);
  });

  it("returns true for a backslash dot-slash relative path", () => {
    expect(isGlobOrFilePath(".\\my-spec.md")).toBe(true);
  });

  it("returns true for a backslash dot-dot relative path", () => {
    expect(isGlobOrFilePath("..\\specs\\feature.md")).toBe(true);
  });

  it("returns true for a backslash dot-slash relative path without extension", () => {
    expect(isGlobOrFilePath(".\\foo")).toBe(true);
  });

  it("returns true for a backslash dot-dot relative path with nested dirs", () => {
    expect(isGlobOrFilePath("..\\bar\\baz.md")).toBe(true);
  });

  it("returns true for an absolute Unix path", () => {
    expect(isGlobOrFilePath("/home/user/spec.md")).toBe(true);
  });

  it("returns true for a Windows-style backslash path", () => {
    expect(isGlobOrFilePath("docs\\specs\\feature.md")).toBe(true);
  });

  it("returns true for a path with multiple directories", () => {
    expect(isGlobOrFilePath("src/tests/spec-generator.test.ts")).toBe(true);
  });

  // --- Bare filenames with extensions (true) ---

  it("returns true for a bare .md filename", () => {
    expect(isGlobOrFilePath("spec.md")).toBe(true);
  });

  it("returns true for a bare .txt filename", () => {
    expect(isGlobOrFilePath("notes.txt")).toBe(true);
  });

  it("returns true for a bare .json filename", () => {
    expect(isGlobOrFilePath("config.json")).toBe(true);
  });

  it("returns true for a bare .ts filename", () => {
    expect(isGlobOrFilePath("index.ts")).toBe(true);
  });

  it("returns true for a bare .yaml filename", () => {
    expect(isGlobOrFilePath("config.yaml")).toBe(true);
  });

  it("returns true for a .yml filename", () => {
    expect(isGlobOrFilePath("config.yml")).toBe(true);
  });

  it("returns true for a .js filename", () => {
    expect(isGlobOrFilePath("index.js")).toBe(true);
  });

  it("returns true for a .tsx filename", () => {
    expect(isGlobOrFilePath("Component.tsx")).toBe(true);
  });

  it("returns true for a .jsx filename", () => {
    expect(isGlobOrFilePath("Component.jsx")).toBe(true);
  });

  it("returns true for a filename with uppercase extension", () => {
    expect(isGlobOrFilePath("README.MD")).toBe(true);
  });

  it("returns true for a hyphenated filename with extension", () => {
    expect(isGlobOrFilePath("my-feature.md")).toBe(true);
  });

  // --- Inline text strings (false) ---

  it("returns false for a plain text sentence", () => {
    expect(isGlobOrFilePath("feature A should do x")).toBe(false);
  });

  it("returns false for a multi-word description", () => {
    expect(isGlobOrFilePath("add dark mode toggle to settings page")).toBe(false);
  });

  it("returns false for a single word", () => {
    expect(isGlobOrFilePath("refactor")).toBe(false);
  });

  it("returns false for a sentence with punctuation", () => {
    expect(isGlobOrFilePath("add validation for email, phone, and address")).toBe(false);
  });

  it("returns false for a sentence with a colon", () => {
    expect(isGlobOrFilePath("feat: add user authentication")).toBe(false);
  });

  it("returns false for a sentence with parentheses", () => {
    expect(isGlobOrFilePath("implement caching (redis)")).toBe(false);
  });

  it("returns false for a sentence with a dash", () => {
    expect(isGlobOrFilePath("add dark-mode support")).toBe(false);
  });

  it("returns false for text with special characters but no glob or path indicators", () => {
    expect(isGlobOrFilePath("add validation — ensure inputs are correct")).toBe(false);
  });

  it("returns false for text with numbers but no path indicators", () => {
    expect(isGlobOrFilePath("add 2 new fields to the form")).toBe(false);
  });

  it("returns false for text with a period but no recognized extension", () => {
    expect(isGlobOrFilePath("update the U.S. address form")).toBe(false);
  });

  // --- Edge cases ---

  it("returns false for an empty string", () => {
    expect(isGlobOrFilePath("")).toBe(false);
  });

  it("returns false for whitespace only", () => {
    expect(isGlobOrFilePath("   ")).toBe(false);
  });

  it("returns false for a string with special characters but no glob or path chars", () => {
    expect(isGlobOrFilePath("hello @world #test")).toBe(false);
  });

  it("returns false for a string with equals sign", () => {
    expect(isGlobOrFilePath("key=value")).toBe(false);
  });

  it("returns false for a quoted phrase", () => {
    expect(isGlobOrFilePath("\"add new feature\"")).toBe(false);
  });

  it("returns false for a string with exclamation mark", () => {
    expect(isGlobOrFilePath("fix the bug!")).toBe(false);
  });

  it("returns true for a lone forward slash", () => {
    expect(isGlobOrFilePath("/")).toBe(true);
  });

  it("returns true for a lone asterisk", () => {
    expect(isGlobOrFilePath("*")).toBe(true);
  });

  it("returns true for a dot followed by extension only", () => {
    expect(isGlobOrFilePath(".md")).toBe(true);
  });

  it("returns false for a string ending with a long pseudo-extension", () => {
    expect(isGlobOrFilePath("something.toolong")).toBe(false);
  });

  it("returns false for a string with a dot but no valid extension", () => {
    expect(isGlobOrFilePath("version 2.0 is ready")).toBe(false);
  });

  it("returns false for a number string", () => {
    expect(isGlobOrFilePath("42")).toBe(false);
  });

  it("returns false for comma-separated numbers", () => {
    expect(isGlobOrFilePath("1,2,3")).toBe(false);
  });
});

describe("buildFileSpecPrompt", () => {
  const FILE_PATH = "/home/user/drafts/my-feature.md";
  const CONTENT = "This is the feature description.\n\nIt has multiple paragraphs.";
  const CWD = "/home/user/project";

  it("returns a string", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(typeof result).toBe("string");
  });

  it("extracts title from first H1 heading when content contains one", () => {
    const headingContent = "# My Feature Title\n\nThis is the description.";
    const result = buildFileSpecPrompt(FILE_PATH, headingContent, CWD);
    expect(result).toContain("- **Title:** My Feature Title");
  });

  it("prefers the first H1 heading over the filename", () => {
    const headingContent = "# Use First Heading as Title\n\nSome body text.";
    const result = buildFileSpecPrompt("/home/user/drafts/some-other-name.md", headingContent, CWD);
    expect(result).toContain("- **Title:** Use First Heading as Title");
    expect(result).not.toContain("- **Title:** some-other-name");
  });

  it("extracts title from first content line when no H1 heading exists", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("- **Title:** This is the feature description.");
  });

  it("extracts title from content when only H2 or lower headings exist", () => {
    const noH1Content = "## Subheading Only\n\nNo top-level heading here.";
    const result = buildFileSpecPrompt(FILE_PATH, noH1Content, CWD);
    expect(result).toContain("- **Title:** Subheading Only");
  });

  it("includes the source file path", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain(`- **Source file:** ${FILE_PATH}`);
  });

  it("includes the file content under a Content heading", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("### Content");
    expect(result).toContain(CONTENT);
  });

  it("uses the file path as the output path", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain(`\`${FILE_PATH}\``);
  });

  it("includes the working directory", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain(`\`${CWD}\``);
  });

  it("includes the spec agent preamble", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("You are a **spec agent**");
  });

  it("includes the two-stage pipeline explanation", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("planner agent");
    expect(result).toContain("coder agent");
  });

  it("includes all required spec sections in the template", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("## Context");
    expect(result).toContain("## Why");
    expect(result).toContain("## Approach");
    expect(result).toContain("## Integration Points");
    expect(result).toContain("## Tasks");
    expect(result).toContain("## References");
    expect(result).toContain("## Key Guidelines");
  });

  it("includes (P)/(S) tagging instructions", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("`(P)`");
    expect(result).toContain("`(S)`");
    expect(result).toContain("**Parallel-safe.**");
    expect(result).toContain("**Serial / dependent.**");
  });

  it("includes the task example", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("- [ ] (P) Add validation helper to the form utils module");
    expect(result).toContain("- [ ] (S) Refactor the form component to use the new validation helper");
  });

  it("includes all five instructions", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("1. **Explore the codebase**");
    expect(result).toContain("2. **Understand the content**");
    expect(result).toContain("3. **Research the approach**");
    expect(result).toContain("4. **Identify integration points**");
    expect(result).toContain("5. **DO NOT make any code changes**");
  });

  it("does not include issue-specific metadata", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).not.toContain("**Number:**");
    expect(result).not.toContain("**State:**");
    expect(result).not.toContain("**URL:**");
    expect(result).not.toContain("**Labels:**");
    expect(result).not.toContain("### Acceptance Criteria");
    expect(result).not.toContain("### Discussion");
  });

  it("uses # <Title> in the output template instead of # <Issue title> (#<number>)", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("# <Title>");
    expect(result).not.toContain("(#<number>)");
  });

  it("omits Content section when content is empty", () => {
    const result = buildFileSpecPrompt(FILE_PATH, "", CWD);
    expect(result).not.toContain("### Content");
  });

  it("handles a file path without .md extension", () => {
    const result = buildFileSpecPrompt("/home/user/drafts/feature.txt", CONTENT, CWD);
    // extractTitle derives title from content, not from filename
    expect(result).toContain("- **Title:** This is the feature description.");
  });

  it("includes all key guidelines", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("**Stay high-level.**");
    expect(result).toContain("**Respect the project's stack.**");
    expect(result).toContain("**Explain WHAT, WHY, and HOW (strategically).**");
    expect(result).toContain("**Detail integration points.**");
    expect(result).toContain("**Keep tasks atomic and ordered.**");
    expect(result).toContain("**Tag every task with `(P)`, `(S)`, or `(I)`.**");
    expect(result).toContain("**Keep the markdown clean**");
  });
});

describe("validateSpecStructure", () => {
  it("returns valid for a well-formed spec", () => {
    const content = [
      "# My Feature (#42)",
      "",
      "> Summary of the feature",
      "",
      "## Context",
      "",
      "Some context here.",
      "",
      "## Tasks",
      "",
      "- [ ] (P) First task",
      "- [ ] (S) Second task",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result).toEqual({ valid: true });
  });

  it("returns invalid when content does not start with H1 heading", () => {
    const content = [
      "Some preamble text",
      "",
      "# My Feature (#42)",
      "",
      "## Tasks",
      "",
      "- [ ] A task",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("H1 heading");
  });

  it("returns invalid when ## Tasks section is missing", () => {
    const content = [
      "# My Feature (#42)",
      "",
      "## Context",
      "",
      "Some context.",
      "",
      "## Approach",
      "",
      "Some approach.",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("## Tasks");
  });

  it("returns invalid when ## Tasks section has no checkboxes", () => {
    const content = [
      "# My Feature (#42)",
      "",
      "## Tasks",
      "",
      "Some text but no actual task checkboxes.",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("no unchecked tasks");
  });

  it("returns valid when content has leading whitespace before H1", () => {
    const content = [
      "",
      "  ",
      "# My Feature (#42)",
      "",
      "## Tasks",
      "",
      "- [ ] A task",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result).toEqual({ valid: true });
  });

  it("returns invalid for empty content", () => {
    const result = validateSpecStructure("");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("H1 heading");
  });

  it("returns invalid for conversational AI response content", () => {
    const content = "The spec file has been written to .dispatch/specs/10-feature.md";

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(false);
  });

  it("does not count checkboxes that appear before ## Tasks", () => {
    const content = [
      "# My Feature (#42)",
      "",
      "## Context",
      "",
      "- [ ] This checkbox is in context, not tasks",
      "",
      "## Tasks",
      "",
      "No checkboxes in the tasks section.",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("no unchecked tasks");
  });

  it("returns valid with a single checkbox in Tasks section", () => {
    const content = [
      "# Minimal Spec",
      "",
      "## Tasks",
      "",
      "- [ ] The only task",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result).toEqual({ valid: true });
  });

  it("returns valid when checked and unchecked tasks coexist", () => {
    const content = [
      "# My Feature",
      "",
      "## Tasks",
      "",
      "- [x] Already done",
      "- [ ] Still pending",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result).toEqual({ valid: true });
  });

  it("returns invalid when ## Tasks is a substring of another heading", () => {
    const content = [
      "# My Feature",
      "",
      "## Tasks and Notes",
      "",
      "- [ ] A task",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("## Tasks");
  });

  it("does not have a reason property when valid", () => {
    const content = [
      "# Valid Spec",
      "",
      "## Tasks",
      "",
      "- [ ] Do something",
    ].join("\n");

    const result = validateSpecStructure(content);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─── extractSpecContent (pure, no I/O) ───────────────────────────────

describe("extractSpecContent", () => {
  it("passes through already-clean content unchanged", () => {
    const clean = [
      "# My Spec (#1)",
      "",
      "> Summary of the spec",
      "",
      "## Context",
      "",
      "Some context here.",
      "",
      "## Tasks",
      "",
      "- [ ] First task",
      "",
      "## References",
      "",
      "- Link to issue",
      "",
    ].join("\n");

    const result = extractSpecContent(clean);
    expect(result).toBe(clean.trimEnd() + "\n");
  });

  it("strips markdown code-fence wrapping", () => {
    const wrapped = [
      "```markdown",
      "# My Spec (#1)",
      "",
      "> Summary",
      "",
      "## Context",
      "",
      "Details here.",
      "",
      "## Tasks",
      "",
      "- [ ] Do something",
      "```",
    ].join("\n");

    const result = extractSpecContent(wrapped);
    expect(result).toContain("# My Spec (#1)");
    expect(result).not.toContain("```");
  });

  it("strips bare code-fence wrapping without language tag", () => {
    const wrapped = [
      "```",
      "# My Spec (#1)",
      "",
      "## Tasks",
      "",
      "- [ ] Task",
      "```",
    ].join("\n");

    const result = extractSpecContent(wrapped);
    expect(result).toContain("# My Spec (#1)");
    expect(result).not.toContain("```");
  });

  it("removes preamble text before the first H1 heading", () => {
    const withPreamble = [
      "Here's the spec file I've written:",
      "",
      "# My Spec (#1)",
      "",
      "> Summary",
      "",
      "## Context",
      "",
      "Details.",
      "",
      "## Tasks",
      "",
      "- [ ] Task one",
    ].join("\n");

    const result = extractSpecContent(withPreamble);
    expect(result).toMatch(/^# My Spec/);
    expect(result).not.toContain("Here's the spec file");
  });

  it("removes postamble text after the last recognized section", () => {
    const withPostamble = [
      "# My Spec (#1)",
      "",
      "> Summary",
      "",
      "## Context",
      "",
      "Details.",
      "",
      "## Tasks",
      "",
      "- [ ] Task one",
      "",
      "## Summary",
      "",
      "Here's a summary of what I wrote for you.",
    ].join("\n");

    const result = extractSpecContent(withPostamble);
    expect(result).toContain("# My Spec (#1)");
    expect(result).toContain("## Tasks");
    expect(result).toContain("- [ ] Task one");
    expect(result).not.toContain("## Summary");
    expect(result).not.toContain("Here's a summary of what I wrote");
  });

  it("handles content with both preamble and postamble", () => {
    const messy = [
      "I've written the spec to the file. Here it is:",
      "",
      "```markdown",
      "# My Spec (#1)",
      "",
      "> Summary",
      "",
      "## Context",
      "",
      "Context details.",
      "",
      "## Tasks",
      "",
      "- [ ] Do the thing",
      "",
      "## References",
      "",
      "- https://example.com",
      "```",
      "",
      "Let me know if you'd like me to make any changes!",
    ].join("\n");

    const result = extractSpecContent(messy);
    expect(result).toMatch(/^# My Spec/);
    expect(result).toContain("## Context");
    expect(result).toContain("## Tasks");
    expect(result).toContain("- [ ] Do the thing");
    expect(result).toContain("## References");
    expect(result).not.toContain("I've written the spec");
    expect(result).not.toContain("Let me know");
    expect(result).not.toContain("```");
  });

  it("returns unrecognizable content as-is when no H1 heading found", () => {
    const noSpec = "The spec file has been written to .dispatch/specs/10-spec.md";
    const result = extractSpecContent(noSpec);
    expect(result).toBe(noSpec);
  });

  it("returns content as-is when it has no H1 heading after fence stripping", () => {
    const noH1 = [
      "Some random text",
      "without any headings",
      "or structure",
    ].join("\n");

    const result = extractSpecContent(noH1);
    expect(result).toBe(noH1);
  });

  it("handles empty string input", () => {
    const result = extractSpecContent("");
    expect(result).toBe("");
  });

  it("preserves all recognized H2 sections", () => {
    const fullSpec = [
      "# Complete Spec (#5)",
      "",
      "> Summary line",
      "",
      "## Context",
      "",
      "Context content.",
      "",
      "## Why",
      "",
      "Why content.",
      "",
      "## Approach",
      "",
      "Approach content.",
      "",
      "## Integration Points",
      "",
      "Integration content.",
      "",
      "## Tasks",
      "",
      "- [ ] Task one",
      "- [ ] Task two",
      "",
      "## References",
      "",
      "- Link one",
      "",
      "## Key Guidelines",
      "",
      "- Guideline one",
    ].join("\n");

    const result = extractSpecContent(fullSpec);
    expect(result).toContain("## Context");
    expect(result).toContain("## Why");
    expect(result).toContain("## Approach");
    expect(result).toContain("## Integration Points");
    expect(result).toContain("## Tasks");
    expect(result).toContain("## References");
    expect(result).toContain("## Key Guidelines");
  });

  it("does not strip internal code fences within the spec", () => {
    const withInternalFence = [
      "# My Spec (#1)",
      "",
      "## Context",
      "",
      "Example code:",
      "",
      "```typescript",
      "const x = 1;",
      "```",
      "",
      "## Tasks",
      "",
      "- [ ] Task",
    ].join("\n");

    const result = extractSpecContent(withInternalFence);
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
  });

  it("handles content where only preamble exists before H1 with no postamble", () => {
    const preambleOnly = [
      "Sure! Here's the spec:",
      "",
      "# Spec Title (#3)",
      "",
      "## Tasks",
      "",
      "- [ ] A task",
    ].join("\n");

    const result = extractSpecContent(preambleOnly);
    expect(result).toMatch(/^# Spec Title/);
    expect(result).not.toContain("Sure!");
    expect(result).toContain("- [ ] A task");
  });
});

// ─── SpecAgent ───────────────────────────────────────────────────────

describe("SpecAgent boot", () => {
  it("throws when provider is not supplied", async () => {
    await expect(boot({ cwd: "/tmp" })).rejects.toThrow(
      "Spec agent requires a provider instance in boot options"
    );
  });

  it("returns an agent with name 'spec'", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(agent.name).toBe("spec");
  });

  it("returns an agent with generate and cleanup methods", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(typeof agent.generate).toBe("function");
    expect(typeof agent.cleanup).toBe("function");
  });
});

describe("SpecAgent generate", () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(randomUUID).mockReturnValue("test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const VALID_SPEC = [
    "# My Feature (#42)",
    "",
    "> Summary of the feature",
    "",
    "## Context",
    "",
    "Some context here.",
    "",
    "## Tasks",
    "",
    "- [ ] (P) First task",
    "- [ ] (S) Second task",
  ].join("\n");

  const ISSUE_FIXTURE: IssueDetails = {
    number: "42",
    title: "My Feature",
    body: "Implement the feature",
    labels: ["enhancement"],
    state: "open",
    url: "https://github.com/org/repo/issues/42",
    comments: [],
    acceptanceCriteria: "",
  };

  it("generates a spec successfully with the temp file workflow", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response text"),
    });

    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(true);
    expect(result.data!.content).toContain("# My Feature (#42)");
    expect(result.data!.content).toContain("## Tasks");
    expect(result.error).toBeUndefined();

    // Verify temp dir was created
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining(join(".dispatch", "tmp")),
      { recursive: true }
    );

    // Verify provider was called
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledOnce();

    // Verify temp file was read
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining("spec-test-uuid-1234.md"),
      "utf-8"
    );

    // Verify final output was written
    expect(writeFile).toHaveBeenCalledWith(
      resolve("/tmp/project/.dispatch/specs/42-my-feature.md"),
      expect.any(String),
      "utf-8"
    );

    // Verify temp file was cleaned up
    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining("spec-test-uuid-1234.md")
    );
  });

  it("generates a spec from file content (file/glob mode)", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      filePath: "/tmp/project/drafts/feature.md",
      fileContent: "# Feature\n\nDescription of the feature.",
      cwd: "/tmp/project",
      outputPath: "/tmp/project/drafts/feature.md",
    });

    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(true);
  });

  it("forwards provider progress snapshots upward", async () => {
    const onProgress = vi.fn<(snapshot: ProviderProgressSnapshot) => void>();
    const snapshot = { text: "Generating outline" };
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockImplementation(async (_sessionId, _prompt, options) => {
        options?.onProgress?.(snapshot);
        return "AI response";
      }),
    });

    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
      onProgress,
    });

    expect(result.success).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(snapshot);
    expect(provider.prompt).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      expect.objectContaining({ onProgress }),
    );
  });

  it("returns failure when AI returns null response", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(null),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("AI agent returned no response");
    expect(result.data).toBeNull();
  });

  it("returns failure when neither issue nor filePath+fileContent is provided", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/output.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Either issue, inlineText, or filePath+fileContent must be provided");
    expect(result.data).toBeNull();
  });

  it("returns failure when the AI does not write the temp file", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("Some response"),
    });

    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT: no such file"));

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Spec agent did not write the file");
    expect(result.error).toContain("Some response");
    expect(result.data).toBeNull();
  });

  it("returns failure when provider.createSession throws", async () => {
    const provider = createMockProvider({
      createSession: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection refused");
    expect(result.data).toBeNull();
  });

  it("returns failure when provider.prompt throws", async () => {
    const provider = createMockProvider({
      prompt: vi.fn().mockRejectedValue(new Error("Model overloaded")),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Model overloaded");
    expect(result.data).toBeNull();
  });

  it("cleans up temp file on successful generation", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);

    const agent = await boot({ cwd: "/tmp/project", provider });
    await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining("spec-test-uuid-1234.md")
    );
  });

  it("does not throw when temp file cleanup fails", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);
    vi.mocked(unlink).mockRejectedValue(new Error("ENOENT"));

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    // Should still succeed despite cleanup failure
    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(true);
  });

  it("reports validation warnings for structurally invalid specs", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    const invalidSpec = "# My Feature\n\nNo tasks section here.";
    vi.mocked(readFile).mockResolvedValue(invalidSpec);

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    // Generation succeeds but validation reports invalid
    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(false);
    expect(result.data!.validationReason).toBeDefined();
  });

  it("uses unique temp file paths per generation via randomUUID", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);

    // Override the default mock to return unique UUIDs sequentially
    vi.mocked(randomUUID)
      .mockReturnValueOnce("uuid-first" as `${string}-${string}-${string}-${string}-${string}`)
      .mockReturnValueOnce("uuid-second" as `${string}-${string}-${string}-${string}-${string}`);

    const agent = await boot({ cwd: "/tmp/project", provider });

    await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-first.md",
    });

    await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-second.md",
    });

    const readCalls = vi.mocked(readFile).mock.calls;
    expect(readCalls[0][0]).toContain("spec-uuid-first.md");
    expect(readCalls[1][0]).toContain("spec-uuid-second.md");
  });

  it("handles non-Error exceptions gracefully", async () => {
    const provider = createMockProvider({
      createSession: vi.fn().mockRejectedValue("raw string error"),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("raw string error");
  });
});

// ─── spec output formatting (runSpecPipeline log output) ─────────────

describe("spec output formatting", () => {
  const CWD = "/tmp/test-project";
  const OUTPUT_DIR = "/tmp/test-project/.dispatch/specs";

  const VALID_SPEC = [
    "# My Feature (#42)",
    "",
    "> Summary of the feature",
    "",
    "## Context",
    "",
    "Some context here.",
    "",
    "## Tasks",
    "",
    "- [ ] (P) First task",
    "- [ ] (S) Second task",
  ].join("\n");

  beforeEach(() => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);
    vi.mocked(randomUUID).mockReturnValue("test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`);

    // bootProvider returns a mock provider whose prompt triggers the spec agent
    // to write valid content
    vi.mocked(bootProvider).mockResolvedValue({
      name: "mock",
      model: "mock-model",
      createSession: vi.fn().mockResolvedValue("session-1"),
      prompt: vi.fn().mockResolvedValue("done"),
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows issue numbers in dispatch command for tracker mode (github)", async () => {
    const mockDs = createMockDatasource("github");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("github");

    await runSpecPipeline({
      issues: "1,2,3",
      issueSource: "github",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const dimCalls = vi.mocked(log.dim).mock.calls.map((c) => c[0]);
    const runLine = dimCalls.find((msg) => typeof msg === "string" && msg.includes("dispatch"));

    expect(runLine).toBeDefined();
    // Should show issue numbers, not a glob path
    expect(runLine).toContain("dispatch 1,2,3");
    expect(runLine).not.toContain("*.md");
  });

  it("shows issue numbers in dispatch command for tracker mode (azdevops)", async () => {
    const mockDs = createMockDatasource("azdevops");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("azdevops");

    await runSpecPipeline({
      issues: "100,200",
      issueSource: "azdevops",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const dimCalls = vi.mocked(log.dim).mock.calls.map((c) => c[0]);
    const runLine = dimCalls.find((msg) => typeof msg === "string" && msg.includes("dispatch"));

    expect(runLine).toBeDefined();
    expect(runLine).toContain("dispatch 100,200");
  });

  it("shows created issue numbers in dispatch command for file/glob mode with tracker datasource", async () => {
    const mockDs = createMockDatasource("github", {
      create: vi.fn<Datasource["create"]>()        .mockResolvedValueOnce({
          number: "55",
          title: "Feature A",
          body: "content",
          labels: [],
          state: "open",
          url: "https://github.com/org/repo/issues/55",
          comments: [],
          acceptanceCriteria: "",
        })
        .mockResolvedValueOnce({
          number: "56",
          title: "Feature B",
          body: "content",
          labels: [],
          state: "open",
          url: "https://github.com/org/repo/issues/56",
          comments: [],
          acceptanceCriteria: "",
        }),
    });
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("github");
    vi.mocked(globFn).mockResolvedValue(["/tmp/test-project/drafts/a.md", "/tmp/test-project/drafts/b.md"] as any);

    await runSpecPipeline({
      issues: "drafts/*.md",
      issueSource: "github",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const dimCalls = vi.mocked(log.dim).mock.calls.map((c) => c[0]);
    const runLine = dimCalls.find((msg) => typeof msg === "string" && msg.includes("dispatch"));

    expect(runLine).toBeDefined();
    // Should show newly created issue numbers, not file paths
    expect(runLine).toContain("55");
    expect(runLine).toContain("56");
    expect(runLine).not.toContain("drafts/a.md");
    expect(runLine).not.toContain("drafts/b.md");
  });

  it("shows numeric ID in dispatch command for file/glob mode with md datasource", async () => {
    const mockDs = createMockDatasource("md");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);
    vi.mocked(globFn).mockResolvedValue(["/tmp/test-project/drafts/feature.md"] as any);

    await runSpecPipeline({
      issues: "drafts/*.md",
      issueSource: "md",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const dimCalls = vi.mocked(log.dim).mock.calls.map((c) => c[0]);
    const runLine = dimCalls.find((msg) => typeof msg === "string" && msg.includes("dispatch"));

    expect(runLine).toBeDefined();
    // After create(), identifier is numeric — dispatch hint shows the ID
    expect(runLine).toContain("dispatch 99");
  });

  it("shows single issue number for tracker mode with one issue", async () => {
    const mockDs = createMockDatasource("github");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);

    await runSpecPipeline({
      issues: "42",
      issueSource: "github",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const dimCalls = vi.mocked(log.dim).mock.calls.map((c) => c[0]);
    const runLine = dimCalls.find((msg) => typeof msg === "string" && msg.includes("dispatch"));

    expect(runLine).toBeDefined();
    expect(runLine).toContain("dispatch 42");
  });
});

// ─── inline text pipeline (runSpecPipeline inline text branch) ───────

describe("inline text pipeline", () => {
  const CWD = "/tmp/test-project";
  const OUTPUT_DIR = "/tmp/test-project/.dispatch/specs";

  const VALID_SPEC = [
    "# My Feature (#42)",
    "",
    "> Summary of the feature",
    "",
    "## Context",
    "",
    "Some context here.",
    "",
    "## Tasks",
    "",
    "- [ ] (P) First task",
    "- [ ] (S) Second task",
  ].join("\n");

  beforeEach(() => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);
    vi.mocked(randomUUID).mockReturnValue("test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`);

    vi.mocked(bootProvider).mockResolvedValue({
      name: "mock",
      model: "mock-model",
      createSession: vi.fn().mockResolvedValue("session-1"),
      prompt: vi.fn().mockResolvedValue("done"),
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("generates a spec file for inline text input", async () => {
    const mockDs = createMockDatasource("md");
    vi.mocked(mockDs.create).mockResolvedValue({
      number: "99",
      title: "My Feature",
      body: "Spec content",
      labels: [],
      state: "open",
      url: `${OUTPUT_DIR}/99-my-feature.md`,
      comments: [],
      acceptanceCriteria: "",
    });
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const result = await runSpecPipeline({
      issues: "add dark mode toggle to settings page",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(1);
    expect(result.files).toHaveLength(1);
    // After create(), filepath is updated to the created spec file path
    expect(result.files[0]).toContain("99-my-feature.md");
  });

  it("shows numeric ID in dispatch command for inline text with md datasource", async () => {
    const mockDs = createMockDatasource("md");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    await runSpecPipeline({
      issues: "add dark mode toggle to settings page",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const dimCalls = vi.mocked(log.dim).mock.calls.map((c) => c[0]);
    const runLine = dimCalls.find((msg) => typeof msg === "string" && msg.includes("dispatch"));

    expect(runLine).toBeDefined();
    // After create(), identifier is numeric — dispatch hint shows the ID
    expect(runLine).toContain("dispatch 99");
  });

  it("truncates long inline text in spec title", async () => {
    const mockDs = createMockDatasource("md");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const longInput = "implement a comprehensive user authentication system with oauth2 support and multi-factor authentication for the admin panel";

    await runSpecPipeline({
      issues: longInput,
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    const infoCalls = vi.mocked(log.info).mock.calls.map((c) => c[0]);
    const inlineLine = infoCalls.find((msg) => typeof msg === "string" && msg.includes("Inline text spec:"));

    expect(inlineLine).toBeDefined();
    // The title is truncated to 80 chars + "…"
    expect(inlineLine).toContain("…");
  });

  it("slugifies inline text into the output filename", async () => {
    const mockDs = createMockDatasource("md");
    vi.mocked(mockDs.create).mockResolvedValue({
      number: "99",
      title: "My Feature",
      body: "Spec content",
      labels: [],
      state: "open",
      url: `${OUTPUT_DIR}/99-my-feature.md`,
      comments: [],
      acceptanceCriteria: "",
    });
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const result = await runSpecPipeline({
      issues: "Add validation for email & phone",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.files).toHaveLength(1);
    // After create(), filepath is updated to the created spec file path
    expect(result.files[0]).toContain("99-my-feature.md");
  });

  it("passes inline text as fileContent to spec agent", async () => {
    const mockDs = createMockDatasource("md");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const mockProvider = {
      name: "mock",
      model: "mock-model",
      createSession: vi.fn().mockResolvedValue("session-1"),
      prompt: vi.fn().mockResolvedValue("done"),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(bootProvider).mockResolvedValue(mockProvider);

    const inlineText = "add user profile page";

    await runSpecPipeline({
      issues: inlineText,
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    // The spec agent's prompt should contain the inline text
    // Since the agent is called via provider.prompt, check that the prompt
    // was called and the session was created
    expect(mockProvider.createSession).toHaveBeenCalled();
    expect(mockProvider.prompt).toHaveBeenCalled();

    // Verify writeFile was called with the expected output path
    const writeFileCalls = vi.mocked(writeFile).mock.calls;
    const specWriteCall = writeFileCalls.find(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("add-user-profile-page.md")
    );
    expect(specWriteCall).toBeDefined();

    // After generation, the pipeline renames to the H1-derived filename
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining("add-user-profile-page.md"),
      expect.stringContaining("my-feature-42.md")
    );
  });

  it("returns spec summary with identifiers for inline text", async () => {
    const mockDs = createMockDatasource("md");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const result = await runSpecPipeline({
      issues: "feature A should do x",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.identifiers).toBeDefined();
    expect(result.identifiers).toHaveLength(1);
    // Identifier should be the numeric ID assigned by datasource.create()
    expect(result.identifiers![0]).toBe("99");
    // Issue number should be created via datasource.create()
    expect(result.issueNumbers).toHaveLength(1);
    expect(result.issueNumbers).toContain("99");
  });
});

// ─── H1-to-filename derivation (runSpecPipeline post-generation rename) ──

describe("H1-to-filename derivation", () => {
  const CWD = "/tmp/test-project";
  const OUTPUT_DIR = "/tmp/test-project/.dispatch/specs";

  beforeEach(() => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(randomUUID).mockReturnValue("test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`);

    vi.mocked(bootProvider).mockResolvedValue({
      name: "mock",
      model: "mock-model",
      createSession: vi.fn().mockResolvedValue("session-1"),
      prompt: vi.fn().mockResolvedValue("done"),
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renames tracker mode spec file based on H1 heading from generated content", async () => {
    const specWithCustomH1 = [
      "# Improved Auth Flow (#42)",
      "",
      "> Better auth",
      "",
      "## Context",
      "",
      "Details.",
      "",
      "## Tasks",
      "",
      "- [ ] (P) Task one",
    ].join("\n");

    vi.mocked(readFile).mockResolvedValue(specWithCustomH1);

    const mockDs = createMockDatasource("github");
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("github");

    const result = await runSpecPipeline({
      issues: "42",
      issueSource: "github",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.generated).toBe(1);
    // The file should be named based on the H1 "Improved Auth Flow (#42)" → "improved-auth-flow-42"
    expect(result.files[0]).toContain("42-improved-auth-flow-42.md");
    // rename should have been called since H1 differs from the original tracker title
    expect(rename).toHaveBeenCalled();
  });

  it("does not rename when H1-derived slug matches the pre-generation slug in tracker mode", async () => {
    // The fetch returns title "My Feature" and the H1 in the spec is also "My Feature"
    const specMatchingTitle = [
      "# My Feature",
      "",
      "> Summary",
      "",
      "## Tasks",
      "",
      "- [ ] (P) Task",
    ].join("\n");

    vi.mocked(readFile).mockResolvedValue(specMatchingTitle);

    const mockDs = createMockDatasource("github", {
      fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue({
        number: "10",
        title: "My Feature",
        body: "body",
        labels: [],
        state: "open",
        url: "https://github.com/org/repo/issues/10",
        comments: [],
        acceptanceCriteria: "",
      }),
    });
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue("github");

    const result = await runSpecPipeline({
      issues: "10",
      issueSource: "github",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.generated).toBe(1);
    expect(result.files[0]).toContain("10-my-feature.md");
    // No rename needed since slugs match
    expect(rename).not.toHaveBeenCalled();
  });

  it("renames inline text spec file based on H1 heading from generated content", async () => {
    const specWithH1 = [
      "# Dark Mode Toggle for Settings",
      "",
      "> Add dark mode",
      "",
      "## Tasks",
      "",
      "- [ ] (P) Implement toggle",
    ].join("\n");

    vi.mocked(readFile).mockResolvedValue(specWithH1);

    const mockDs = createMockDatasource("md");
    vi.mocked(mockDs.create).mockResolvedValue({
      number: "99",
      title: "Dark Mode Toggle for Settings",
      body: specWithH1,
      labels: [],
      state: "open",
      url: `${OUTPUT_DIR}/99-dark-mode-toggle-for-settings.md`,
      comments: [],
      acceptanceCriteria: "",
    });
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const result = await runSpecPipeline({
      issues: "add dark mode toggle",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.generated).toBe(1);
    // After create(), filepath is updated to the created spec file path
    expect(result.files[0]).toContain("99-dark-mode-toggle-for-settings.md");
    expect(rename).toHaveBeenCalled();
  });

  it("does not rename file-based specs (file/glob mode overwrites in-place)", async () => {
    const specContent = [
      "# Completely Different Title",
      "",
      "> Summary",
      "",
      "## Tasks",
      "",
      "- [ ] (P) Task",
    ].join("\n");

    vi.mocked(readFile).mockResolvedValue(specContent);
    vi.mocked(globFn).mockResolvedValue(["/tmp/test-project/drafts/original.md"] as any);

    const createdUrl = `${OUTPUT_DIR}/99-completely-different-title.md`;
    const mockDs = createMockDatasource("md");
    vi.mocked(mockDs.create).mockResolvedValue({
      number: "99",
      title: "Completely Different Title",
      body: specContent,
      labels: [],
      state: "open",
      url: createdUrl,
      comments: [],
      acceptanceCriteria: "",
    });
    vi.spyOn(datasourcesIndex, "getDatasource").mockReturnValue(mockDs);
    vi.spyOn(datasourcesIndex, "detectDatasource").mockResolvedValue(null);

    const result = await runSpecPipeline({
      issues: "drafts/*.md",
      issueSource: "md",
      provider: "opencode",
      cwd: CWD,
      outputDir: OUTPUT_DIR,
      concurrency: 10,
    });

    expect(result.generated).toBe(1);
    // After create(), filepath is updated to the newly created spec file
    expect(result.files[0]).toBe(createdUrl);
    // No rename for file/glob mode (rename only runs for tracker/inline modes)
    expect(rename).not.toHaveBeenCalled();
  });
});
