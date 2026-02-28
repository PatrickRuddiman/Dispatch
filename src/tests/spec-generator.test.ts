import { describe, it, expect } from "vitest";
import { isIssueNumbers, buildFileSpecPrompt, validateSpecStructure, extractSpecContent, resolveSource } from "../spec-generator.js";

describe("resolveSource", () => {
  const CWD = "/tmp/fake-repo";

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

  it("defaults to 'md' when no issueSource is provided and input is a glob", async () => {
    const result = await resolveSource("drafts/*.md", undefined, CWD);
    expect(result).toBe("md");
  });

  it("defaults to 'md' when no issueSource is provided and input is a bare filename", async () => {
    const result = await resolveSource("my-spec.md", undefined, CWD);
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
});

describe("buildFileSpecPrompt", () => {
  const FILE_PATH = "/home/user/drafts/my-feature.md";
  const CONTENT = "This is the feature description.\n\nIt has multiple paragraphs.";
  const CWD = "/home/user/project";

  it("returns a string", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(typeof result).toBe("string");
  });

  it("derives the title from the filename without extension", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("- **Title:** my-feature");
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
    // basename("/home/user/drafts/feature.txt", ".md") yields "feature.txt"
    expect(result).toContain("- **Title:** feature.txt");
  });

  it("includes all key guidelines", () => {
    const result = buildFileSpecPrompt(FILE_PATH, CONTENT, CWD);
    expect(result).toContain("**Stay high-level.**");
    expect(result).toContain("**Respect the project's stack.**");
    expect(result).toContain("**Explain WHAT, WHY, and HOW (strategically).**");
    expect(result).toContain("**Detail integration points.**");
    expect(result).toContain("**Keep tasks atomic and ordered.**");
    expect(result).toContain("**Tag every task with `(P)` or `(S)`.**");
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
