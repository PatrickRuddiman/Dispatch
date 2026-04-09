import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type { ProviderInstance } from "../providers/interface.js";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockMkdir, mockWriteFile } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
}));

const { mockRandomUUID } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn().mockReturnValue("aabbccdd-1234-5678-0000-000000000000"),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    extractMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  },
}));

vi.mock("../helpers/file-logger.js", () => ({
  fileLoggerStorage: {
    getStore: vi.fn().mockReturnValue(null),
  },
}));

import { boot, buildCommitPrompt, parseCommitResponse } from "../agents/commit.js";

// ─── Helpers ─────────────────────────────────────────────────

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

function makeIssue(overrides = {}) {
  return {
    number: "42",
    title: "Test issue",
    body: "This is the body",
    labels: ["bug"],
    url: "http://example.com/42",
    state: "open" as const,
    comments: [],
    acceptanceCriteria: "",
    ...overrides,
  };
}

const VALID_RESPONSE = `### COMMIT_MESSAGE\nfeat: add new feature\n\n### PR_TITLE\nAdd new feature\n\n### PR_DESCRIPTION\nThis PR adds a new feature.`;

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRandomUUID.mockReturnValue("aabbccdd-1234-5678-0000-000000000000");
});

// ─── boot ────────────────────────────────────────────────────

describe("boot", () => {
  it("throws when provider is not supplied", async () => {
    await expect(boot({ cwd: "/tmp" })).rejects.toThrow(
      "Commit agent requires a provider instance in boot options"
    );
  });

  it("returns an agent with name 'commit'", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(agent.name).toBe("commit");
  });

  it("returns an agent with generate and cleanup methods", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(typeof agent.generate).toBe("function");
    expect(typeof agent.cleanup).toBe("function");
  });
});

// ─── cleanup ─────────────────────────────────────────────────

describe("cleanup", () => {
  it("resolves without error", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });
});

// ─── generate — success paths ────────────────────────────────

describe("generate — success", () => {
  it("calls provider.createSession and provider.prompt", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(VALID_RESPONSE),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledOnce();
  });

  it("returns success:true with parsed fields on valid response", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(VALID_RESPONSE),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(result.success).toBe(true);
    expect(result.commitMessage).toBe("feat: add new feature");
    expect(result.prTitle).toBe("Add new feature");
    expect(result.prDescription).toBe("This PR adds a new feature.");
  });

  it("writes output file to .dispatch/tmp/<name>.md", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(VALID_RESPONSE),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(join(".dispatch", "tmp")), { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(result.outputPath).toContain("aabbccdd");
  });

  it("returns success:false with error when provider returns empty response", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(""),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty response");
  });

  it("returns success:false when provider returns null", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(null),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty response");
  });

  it("returns success:false when response has no commit message or PR title", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("some random text with no sections"),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to parse");
  });

  it("returns success:false on provider error", async () => {
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockRejectedValue(new Error("network error")),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network error");
  });

  it("returns success:false when mkdir fails", async () => {
    mockMkdir.mockRejectedValueOnce(new Error("permission denied"));
    const provider = createMockProvider({
      prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue(VALID_RESPONSE),
    });
    const agent = await boot({ cwd: "/tmp", provider });
    const result = await agent.generate({ branchDiff: "diff", issue: makeIssue(), taskResults: [], cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("permission denied");
  });
});

// ─── parseCommitResponse ──────────────────────────────────────

describe("parseCommitResponse", () => {
  it("parses all three sections from a well-formed response", () => {
    const result = parseCommitResponse(VALID_RESPONSE);
    expect(result.commitMessage).toBe("feat: add new feature");
    expect(result.prTitle).toBe("Add new feature");
    expect(result.prDescription).toBe("This PR adds a new feature.");
  });

  it("returns empty strings when no sections match", () => {
    const result = parseCommitResponse("nothing here");
    expect(result.commitMessage).toBe("");
    expect(result.prTitle).toBe("");
    expect(result.prDescription).toBe("");
  });

  it("trims whitespace from each section", () => {
    const response = `### COMMIT_MESSAGE\n   fix: trim me   \n\n### PR_TITLE\n  My Title  \n\n### PR_DESCRIPTION\n  Desc  `;
    const result = parseCommitResponse(response);
    expect(result.commitMessage).toBe("fix: trim me");
    expect(result.prTitle).toBe("My Title");
    expect(result.prDescription).toBe("Desc");
  });

  it("is case-insensitive for section headers", () => {
    const response = `### commit_message\nfeat: lower\n### pr_title\nLower Title\n### pr_description\nLower desc`;
    const result = parseCommitResponse(response);
    expect(result.commitMessage).toBe("feat: lower");
    expect(result.prTitle).toBe("Lower Title");
  });

  it("handles multi-line PR description", () => {
    const response = `### COMMIT_MESSAGE\nfeat: thing\n### PR_TITLE\nTitle\n### PR_DESCRIPTION\nLine 1\nLine 2\nLine 3`;
    const result = parseCommitResponse(response);
    expect(result.prDescription).toContain("Line 1");
    expect(result.prDescription).toContain("Line 3");
  });

  it("returns only commitMessage and prTitle when PR_DESCRIPTION is absent", () => {
    const response = `### COMMIT_MESSAGE\nfeat: x\n### PR_TITLE\nX`;
    const result = parseCommitResponse(response);
    expect(result.commitMessage).toBe("feat: x");
    expect(result.prTitle).toBe("X");
    expect(result.prDescription).toBe("");
  });
});

// ─── buildCommitPrompt ────────────────────────────────────────

describe("buildCommitPrompt", () => {
  it("includes the environment section", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff --git a/file.ts b/file.ts",
      issue: makeIssue(),
      taskResults: [],
      cwd: "/tmp/test",
    });
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });

  it("includes the issue number and title", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue({ number: "99", title: "My important issue" }),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).toContain("#99");
    expect(prompt).toContain("My important issue");
  });

  it("includes issue body when present", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue({ body: "This is the description" }),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).toContain("This is the description");
  });

  it("omits description section when body is empty", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue({ body: "" }),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).not.toContain("**Description:**");
  });

  it("includes labels when present", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue({ labels: ["bug", "urgent"] }),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).toContain("bug");
    expect(prompt).toContain("urgent");
  });

  it("omits labels section when labels array is empty", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue({ labels: [] }),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).not.toContain("**Labels:**");
  });

  it("includes completed and failed tasks", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue(),
      taskResults: [
        { success: true, task: { text: "Implement feature" }, error: undefined } as never,
        { success: false, task: { text: "Write tests" }, error: "timeout" } as never,
      ],
      cwd: "/tmp",
    });
    expect(prompt).toContain("Implement feature");
    expect(prompt).toContain("Write tests");
    expect(prompt).toContain("timeout");
  });

  it("truncates very long diffs", () => {
    const bigDiff = "x".repeat(60_000);
    const prompt = buildCommitPrompt({
      branchDiff: bigDiff,
      issue: makeIssue(),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).toContain("diff truncated due to size");
  });

  it("does not truncate diffs within the limit", () => {
    const smallDiff = "small diff content";
    const prompt = buildCommitPrompt({
      branchDiff: smallDiff,
      issue: makeIssue(),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).toContain(smallDiff);
    expect(prompt).not.toContain("truncated");
  });

  it("includes the required output format section", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff",
      issue: makeIssue(),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(prompt).toContain("### COMMIT_MESSAGE");
    expect(prompt).toContain("### PR_TITLE");
    expect(prompt).toContain("### PR_DESCRIPTION");
  });
});
