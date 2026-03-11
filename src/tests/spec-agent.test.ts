import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import type { ProviderInstance } from "../providers/interface.js";
import type { IssueDetails } from "../datasources/interface.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../spec-generator.js", () => ({
  extractSpecContent: vi.fn((raw: string) => raw),
  validateSpecStructure: vi.fn(() => ({ valid: true, reason: undefined })),
}));

vi.mock("../datasources/md.js", () => ({
  extractTitle: vi.fn((_content: string, _filename: string) => "Extracted Title"),
}));

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extractSpecContent, validateSpecStructure } from "../spec-generator.js";
import { extractTitle } from "../datasources/md.js";
import {
  boot,
  buildSpecPrompt,
  buildFileSpecPrompt,
  buildInlineTextSpecPrompt,
} from "../agents/spec.js";

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
// boot
// ---------------------------------------------------------------------------
describe("boot", () => {
  it("throws when provider is not supplied", async () => {
    await expect(boot({ cwd: "/tmp" })).rejects.toThrow(
      "Spec agent requires a provider instance in boot options",
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

  it("cleanup resolves without error", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------
describe("generate", () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(randomUUID).mockReturnValue(
      "test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`,
    );
    vi.mocked(readFile).mockResolvedValue(VALID_SPEC);
    vi.mocked(extractSpecContent).mockImplementation((raw: string) => raw);
    vi.mocked(validateSpecStructure).mockReturnValue({ valid: true, reason: undefined });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("generates a spec from issue details (tracker mode)", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response text"),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(true);
    expect(result.data!.content).toContain("# My Feature (#42)");
    expect(result.error).toBeUndefined();

    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining(join(".dispatch", "tmp")),
      { recursive: true },
    );
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining("spec-test-uuid-1234.md"),
      "utf-8",
    );
    expect(writeFile).toHaveBeenCalledWith(
      resolve("/tmp/project/.dispatch/specs/42-my-feature.md"),
      expect.any(String),
      "utf-8",
    );
    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining("spec-test-uuid-1234.md"),
    );
  });

  it("generates a spec from file content (file/glob mode)", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      filePath: "/tmp/project/drafts/feature.md",
      fileContent: "# Feature\n\nDescription.",
      cwd: "/tmp/project",
      outputPath: "/tmp/project/drafts/feature.md",
    });

    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(true);
  });

  it("generates a spec from inline text", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      inlineText: "Add a new authentication module",
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/auth.md",
    });

    expect(result.success).toBe(true);
    expect(provider.prompt).toHaveBeenCalledOnce();
  });

  it("returns failure when neither issue, inlineText, nor filePath+fileContent is provided", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/output.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Either issue, inlineText, or filePath+fileContent must be provided",
    );
    expect(result.data).toBeNull();
  });

  it("returns failure when only filePath is provided without fileContent", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      filePath: "/some/file.md",
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/output.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Either issue, inlineText, or filePath+fileContent must be provided",
    );
    expect(result.data).toBeNull();
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

  it("returns failure when AI does not write the temp file", async () => {
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

  it("returns failure when outputPath escapes the working directory", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/etc/malicious/output.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes the working directory");
    expect(result.data).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
    expect(provider.createSession).not.toHaveBeenCalled();
  });

  it("does not throw when temp file cleanup fails", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });
    vi.mocked(unlink).mockRejectedValue(new Error("ENOENT"));

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(true);
  });

  it("reports validation warnings for structurally invalid specs", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });
    vi.mocked(validateSpecStructure).mockReturnValue({
      valid: false,
      reason: "Missing Tasks section",
    });

    const agent = await boot({ cwd: "/tmp/project", provider });
    const result = await agent.generate({
      issue: ISSUE_FIXTURE,
      cwd: "/tmp/project",
      outputPath: "/tmp/project/.dispatch/specs/42-my-feature.md",
    });

    expect(result.success).toBe(true);
    expect(result.data!.valid).toBe(false);
    expect(result.data!.validationReason).toBeDefined();
  });

  it("uses unique temp file paths per generation via randomUUID", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("AI response"),
    });

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

  it("includes spec agent preamble", () => {
    const prompt = buildSpecPrompt(ISSUE_FIXTURE, "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("You are a **spec agent**");
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

  it("includes spec agent preamble", () => {
    const prompt = buildFileSpecPrompt("/tmp/project/feature.md", "content", "/tmp/project");
    expect(prompt).toContain("You are a **spec agent**");
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
    expect(prompt).toContain("A".repeat(80) + "…");
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

  it("includes spec agent preamble", () => {
    const prompt = buildInlineTextSpecPrompt("text", "/tmp/project", "/tmp/output.md");
    expect(prompt).toContain("You are a **spec agent**");
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
