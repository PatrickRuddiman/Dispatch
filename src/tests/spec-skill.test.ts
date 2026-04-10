import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IssueDetails } from "../datasources/interface.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../spec-generator.js", () => ({
  extractSpecContent: vi.fn((raw: string) => raw),
  validateSpecStructure: vi.fn(() => ({ valid: true as const })),
  DEFAULT_SPEC_WARN_MIN: 10,
  DEFAULT_SPEC_KILL_MIN: 10,
}));

vi.mock("../datasources/md.js", () => ({
  extractTitle: vi.fn((_content: string, _filename: string) => "Extracted Title"),
}));

import { readFile, writeFile, unlink } from "node:fs/promises";
import { extractSpecContent, validateSpecStructure } from "../spec-generator.js";
import { extractTitle } from "../datasources/md.js";
import {
  specSkill,
  buildSpecPrompt,
  buildFileSpecPrompt,
  buildInlineTextSpecPrompt,
} from "../skills/spec.js";

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

function expectSingleSourceScopeInstructions(prompt: string): void {
  expect(prompt).toContain("Each invocation is scoped to exactly one source item.");
  expect(prompt).toContain("The source item for this invocation is the single passed issue, file, or inline request shown below.");
  expect(prompt).toContain("Treat other repository materials — including existing spec files, sibling issues, and future work — as context only unless the passed source explicitly references them as required context.");
  expect(prompt).toContain("Do not merge unrelated specs, issues, files, or requests into the generated output.");
}

// ---------------------------------------------------------------------------
// specSkill (stateless)
// ---------------------------------------------------------------------------
describe("specSkill", () => {
  it("has name 'spec'", () => {
    expect(specSkill.name).toBe("spec");
  });

  it("has buildPrompt and parseResult functions", () => {
    expect(typeof specSkill.buildPrompt).toBe("function");
    expect(typeof specSkill.parseResult).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------
describe("specSkill.buildPrompt", () => {
  it("builds a prompt from issue details (tracker mode)", () => {
    const prompt = specSkill.buildPrompt({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
      tmpPath: "/tmp/project/.dispatch/tmp/spec-uuid.md",
    });

    expect(prompt).toContain("#42");
    expect(prompt).toContain("My Feature");
    expect(prompt).toContain("/tmp/project/.dispatch/tmp/spec-uuid.md");
  });

  it("builds a prompt from file content (file/glob mode)", () => {
    const prompt = specSkill.buildPrompt({
      filePath: "/tmp/project/drafts/feature.md",
      fileContent: "# Feature\n\nDescription.",
      cwd: "/tmp/project",
      outputPath: "/tmp/project/drafts/feature.md",
      tmpPath: "/tmp/project/.dispatch/tmp/spec-uuid.md",
    });

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("builds a prompt from inline text", () => {
    const prompt = specSkill.buildPrompt({
      inlineText: "Add a new authentication module",
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/auth.md",
      tmpPath: "/tmp/project/.dispatch/tmp/spec-uuid.md",
    });

    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Add a new authentication module");
  });

  it("throws when neither issue, inlineText, nor filePath+fileContent is provided", () => {
    expect(() =>
      specSkill.buildPrompt({
        cwd: "/tmp/project",
        outputPath: "/tmp/project/.dispatch/specs/output.md",
        tmpPath: "/tmp/project/.dispatch/tmp/spec-uuid.md",
      }),
    ).toThrow("Either issue, inlineText, or filePath+fileContent must be provided");
  });

  it("throws when only filePath is provided without fileContent", () => {
    expect(() =>
      specSkill.buildPrompt({
        filePath: "/some/file.md",
        cwd: "/tmp/project",
        outputPath: "/tmp/project/.dispatch/specs/output.md",
        tmpPath: "/tmp/project/.dispatch/tmp/spec-uuid.md",
      }),
    ).toThrow("Either issue, inlineText, or filePath+fileContent must be provided");
  });
});

// ---------------------------------------------------------------------------
// parseResult
// ---------------------------------------------------------------------------
describe("specSkill.parseResult", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(extractSpecContent).mockImplementation((raw: string) => raw);
    vi.mocked(validateSpecStructure).mockReturnValue({ valid: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const baseInput = {
    issue: ISSUE_FIXTURE,
    cwd: "/tmp/project",
    outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    tmpPath: "/tmp/project/.dispatch/tmp/spec-uuid.md",
  };

  it("reads the temp file, processes, and writes to output path", async () => {
    const result = await specSkill.parseResult("AI response text", baseInput);

    expect(result.valid).toBe(true);
    expect(result.content).toContain("# My Feature (#42)");

    expect(readFile).toHaveBeenCalledWith("/tmp/project/.dispatch/tmp/spec-uuid.md", "utf-8");
    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/project/.dispatch/specs/42-my-feature.md",
      expect.any(String),
      "utf-8",
    );
    expect(unlink).toHaveBeenCalledWith("/tmp/project/.dispatch/tmp/spec-uuid.md");
  });

  it("throws when response is null", async () => {
    await expect(specSkill.parseResult(null, baseInput)).rejects.toThrow(
      "AI returned no response",
    );
  });

  it("throws when AI does not write the temp file", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT: no such file"));

    await expect(
      specSkill.parseResult("Some response", baseInput),
    ).rejects.toThrow("Spec skill did not write the file");
  });

  it("reports validation warnings for structurally invalid specs", async () => {
    vi.mocked(validateSpecStructure).mockReturnValue({
      valid: false,
      reason: "Missing Tasks section",
    });

    const result = await specSkill.parseResult("AI response", baseInput);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.validationReason).toBeDefined();
    }
  });

  it("does not throw when temp file cleanup fails", async () => {
    vi.mocked(unlink).mockRejectedValue(new Error("ENOENT"));

    const result = await specSkill.parseResult("AI response", baseInput);

    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSpecPrompt
// ---------------------------------------------------------------------------
describe("buildSpecPrompt", () => {
  it("includes issue details in the prompt", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("My Feature");
    expect(prompt).toContain("open");
    expect(prompt).toContain("https://github.com/org/repo/issues/42");
  });

  it("includes issue labels when present", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("enhancement");
  });

  it("includes issue body as description", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("Implement the feature");
  });

  it("includes acceptance criteria when present", () => {
    const issue: IssueDetails = {
      ...ISSUE_FIXTURE,
      acceptanceCriteria: "Must pass all tests",
    };
    const prompt = buildSpecPrompt(issue, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("Must pass all tests");
  });

  it("includes comments when present", () => {
    const issue: IssueDetails = {
      ...ISSUE_FIXTURE,
      comments: ["First comment", "Second comment"],
    };
    const prompt = buildSpecPrompt(issue, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("First comment");
    expect(prompt).toContain("Second comment");
  });

  it("omits labels section when labels are empty", () => {
    const issue: IssueDetails = { ...ISSUE_FIXTURE, labels: [] };
    const prompt = buildSpecPrompt(issue, "/tmp/project", "/tmp/output.md");
    expect(prompt).not.toContain("**Labels:**");
  });

  it("includes the working directory", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("/tmp/project");
  });

  it("includes the output path", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("/tmp/output.md");
  });

  it("includes spec skill preamble", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("Explore the codebase, understand");
  });

  it("includes (P)/(S) tagging instructions", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("`(P)`");
    expect(prompt).toContain("`(S)`");
  });

  it("includes all required spec template sections", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("## Why");
    expect(prompt).toContain("## Approach");
    expect(prompt).toContain("## Integration Points");
    expect(prompt).toContain("## Tasks");
    expect(prompt).toContain("## References");
    expect(prompt).toContain("## Key Guidelines");
  });

  it("includes environment context section", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("run commands directly");
  });

  it("includes shared scope isolation instructions", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expectSingleSourceScopeInstructions(prompt);
  });
});

// ---------------------------------------------------------------------------
// buildFileSpecPrompt
// ---------------------------------------------------------------------------
describe("buildFileSpecPrompt", () => {
  it("includes file details", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expect(prompt).toContain("/tmp/project/feature.md");
  });

  it("calls extractTitle to derive the title", () => {
    buildFileSpecPrompt("/tmp/project/feature.md", "# My Title\n\nBody", "/tmp/project");
    expect(extractTitle).toHaveBeenCalledWith("# My Title\n\nBody", "/tmp/project/feature.md");
  });

  it("includes file content in the prompt", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "Feature body text", "/tmp/project");
    expect(prompt).toContain("Feature body text");
  });

  it("uses outputPath when provided", () => {
    const prompt = buildFileSpecPrompt(
      "/tmp/project/feature.md",
      "content",
      "/tmp/project",
      "/tmp/project/output.md",
    );
    expect(prompt).toContain("/tmp/project/output.md");
  });

  it("falls back to filePath when outputPath is omitted", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expect(prompt).toContain("/tmp/project/feature.md");
  });

  it("includes spec skill preamble", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expect(prompt).toContain("Explore the codebase, understand");
  });

  it("includes all required spec template sections", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("## Why");
    expect(prompt).toContain("## Approach");
    expect(prompt).toContain("## Integration Points");
    expect(prompt).toContain("## Tasks");
    expect(prompt).toContain("## References");
    expect(prompt).toContain("## Key Guidelines");
  });

  it("includes environment context section", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("run commands directly");
  });

  it("includes shared scope isolation instructions", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expectSingleSourceScopeInstructions(prompt);
  });
});

// ---------------------------------------------------------------------------
// buildInlineTextSpecPrompt
// ---------------------------------------------------------------------------
describe("buildInlineTextSpecPrompt", () => {
  it("includes the inline text in the prompt", () => {
    const prompt = buildInlineTextSpecPrompt("Add auth module", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("Add auth module");
  });

  it("truncates long titles to 80 chars with ellipsis", () => {
    const longText = "A".repeat(100);
    const prompt = buildInlineTextSpecPrompt(longText, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("A".repeat(80) + "\u2026");
  });

  it("does not truncate short titles", () => {
    const prompt = buildInlineTextSpecPrompt("Short title", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("**Title:** Short title");
  });

  it("includes the working directory", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("/tmp/project");
  });

  it("includes the output path", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("/tmp/output.md");
  });

  it("includes spec skill preamble", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("Explore the codebase, understand");
  });

  it("includes all required spec template sections", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("## Why");
    expect(prompt).toContain("## Approach");
    expect(prompt).toContain("## Integration Points");
    expect(prompt).toContain("## Tasks");
    expect(prompt).toContain("## References");
    expect(prompt).toContain("## Key Guidelines");
  });

  it("includes environment context section", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("run commands directly");
  });

  it("includes shared scope isolation instructions", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expectSingleSourceScopeInstructions(prompt);
  });
});
