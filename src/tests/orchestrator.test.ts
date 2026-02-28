import { describe, it, expect } from "vitest";
import { parseIssueFilename } from "../agents/orchestrator.js";

// ─── parseIssueFilename ──────────────────────────────────────────────

describe("parseIssueFilename", () => {
  it("parses a standard issue filename", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc123/42-add-user-auth.md");
    expect(result).toEqual({ issueId: "42", slug: "add-user-auth" });
  });

  it("parses a filename with a long numeric ID", () => {
    const result = parseIssueFilename("/some/path/12345-fix-bug.md");
    expect(result).toEqual({ issueId: "12345", slug: "fix-bug" });
  });

  it("parses a filename with a single-digit ID", () => {
    const result = parseIssueFilename("/tmp/1-a.md");
    expect(result).toEqual({ issueId: "1", slug: "a" });
  });

  it("handles a bare filename without directory path", () => {
    const result = parseIssueFilename("7-my-feature.md");
    expect(result).toEqual({ issueId: "7", slug: "my-feature" });
  });

  it("returns null for a filename without a numeric prefix", () => {
    const result = parseIssueFilename("/tmp/my-feature.md");
    expect(result).toBeNull();
  });

  it("returns null for a filename with no slug after the ID", () => {
    const result = parseIssueFilename("/tmp/42.md");
    expect(result).toBeNull();
  });

  it("returns null for a non-.md file", () => {
    const result = parseIssueFilename("/tmp/42-feature.txt");
    expect(result).toBeNull();
  });

  it("returns null for an empty string", () => {
    const result = parseIssueFilename("");
    expect(result).toBeNull();
  });

  it("preserves hyphens in multi-word slugs", () => {
    const result = parseIssueFilename("99-sync-task-completion-state-back-to-datasource.md");
    expect(result).toEqual({ issueId: "99", slug: "sync-task-completion-state-back-to-datasource" });
  });

  it("extracts both issueId and slug as separate components", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc/123-some-slug.md");
    expect(result).not.toBeNull();
    expect(result!.issueId).toBe("123");
    expect(result!.slug).toBe("some-slug");
  });

  it("returns null for a filename with no extension", () => {
    const result = parseIssueFilename("/tmp/42-feature");
    expect(result).toBeNull();
  });

  it("returns null for a filename with a .json extension", () => {
    const result = parseIssueFilename("10-config.json");
    expect(result).toBeNull();
  });

  it("returns null for a filename with a .markdown extension", () => {
    const result = parseIssueFilename("/tmp/10-notes.markdown");
    expect(result).toBeNull();
  });

  it("returns null when filename starts with a dash", () => {
    const result = parseIssueFilename("-no-id.md");
    expect(result).toBeNull();
  });

  it("returns null for a filename that is just a number with .md", () => {
    const result = parseIssueFilename("123.md");
    expect(result).toBeNull();
  });

  it("handles slug containing dots", () => {
    const result = parseIssueFilename("42-fix-v1.2-bug.md");
    expect(result).toEqual({ issueId: "42", slug: "fix-v1.2-bug" });
  });

  it("handles leading zeros in the issue ID", () => {
    const result = parseIssueFilename("007-bond-feature.md");
    expect(result).toEqual({ issueId: "007", slug: "bond-feature" });
  });

  it("handles a very long numeric ID", () => {
    const result = parseIssueFilename("9999999-edge.md");
    expect(result).toEqual({ issueId: "9999999", slug: "edge" });
  });

  it("returns null for a directory-only path with no filename match", () => {
    const result = parseIssueFilename("/tmp/dispatch-abc123/");
    expect(result).toBeNull();
  });

  it("handles slug that is a single character", () => {
    const result = parseIssueFilename("5-x.md");
    expect(result).toEqual({ issueId: "5", slug: "x" });
  });

  it("returns null when there is no dash separator", () => {
    const result = parseIssueFilename("42feature.md");
    expect(result).toBeNull();
  });
});
