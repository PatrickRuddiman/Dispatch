import { describe, it, expect, vi, beforeEach } from "vitest";

import { commitSkill, buildCommitPrompt, parseCommitResponse } from "../skills/commit.js";

// ─── Helpers ─────────────────────────────────────────────────

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
});

// ─── commitSkill ────────────────────────────────────────────

describe("commitSkill", () => {
  it("has name 'commit'", () => {
    expect(commitSkill.name).toBe("commit");
  });

  it("has buildPrompt and parseResult functions", () => {
    expect(typeof commitSkill.buildPrompt).toBe("function");
    expect(typeof commitSkill.parseResult).toBe("function");
  });
});

// ─── buildPrompt ────────────────────────────────────────────

describe("commitSkill.buildPrompt", () => {
  it("returns a prompt string", () => {
    const prompt = commitSkill.buildPrompt({
      branchDiff: "diff",
      issue: makeIssue(),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ─── parseResult ────────────────────────────────────────────

describe("commitSkill.parseResult", () => {
  it("returns parsed CommitOutput on valid response", () => {
    const result = commitSkill.parseResult(VALID_RESPONSE, {
      branchDiff: "diff",
      issue: makeIssue(),
      taskResults: [],
      cwd: "/tmp",
    });
    expect(result).toEqual({
      commitMessage: "feat: add new feature",
      prTitle: "Add new feature",
      prDescription: "This PR adds a new feature.",
    });
  });

  it("throws when response is empty", () => {
    expect(() =>
      commitSkill.parseResult("", {
        branchDiff: "diff",
        issue: makeIssue(),
        taskResults: [],
        cwd: "/tmp",
      }),
    ).toThrow("empty response");
  });

  it("throws when response is null", () => {
    expect(() =>
      commitSkill.parseResult(null, {
        branchDiff: "diff",
        issue: makeIssue(),
        taskResults: [],
        cwd: "/tmp",
      }),
    ).toThrow("empty response");
  });

  it("throws when response has no commit message or PR title", () => {
    expect(() =>
      commitSkill.parseResult("some random text with no sections", {
        branchDiff: "diff",
        issue: makeIssue(),
        taskResults: [],
        cwd: "/tmp",
      }),
    ).toThrow("Failed to parse");
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
