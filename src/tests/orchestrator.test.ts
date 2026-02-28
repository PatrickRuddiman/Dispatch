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
});
