import { describe, it, expect } from "vitest";
import { slugify } from "../helpers/slugify.js";

// ─── slugify ─────────────────────────────────────────────────────────

describe("slugify", () => {
  it("converts a simple title to a lowercase slug", () => {
    expect(slugify("Add User Auth")).toBe("add-user-auth");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(slugify("Fix Bug #123 (Urgent!)")).toBe("fix-bug-123-urgent");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---Special---")).toBe("special");
  });

  it("collapses consecutive non-alphanumeric characters into a single hyphen", () => {
    expect(slugify("hello   world!!!")).toBe("hello-world");
  });

  it("returns an empty string for an empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("returns an empty string for input with only special characters", () => {
    expect(slugify("!@#$%^&*()")).toBe("");
  });

  it("handles mixed case and preserves digits", () => {
    expect(slugify("Hello WORLD 42 Test")).toBe("hello-world-42-test");
  });

  it("handles input that is already a valid slug", () => {
    expect(slugify("already-a-slug")).toBe("already-a-slug");
  });

  it("handles single character input", () => {
    expect(slugify("A")).toBe("a");
  });

  it("handles input with leading special characters", () => {
    expect(slugify("!!!hello")).toBe("hello");
  });

  it("handles input with trailing special characters", () => {
    expect(slugify("hello!!!")).toBe("hello");
  });

  it("handles input with unicode characters", () => {
    expect(slugify("café résumé")).toBe("caf-r-sum");
  });

  it("handles input with newlines and tabs", () => {
    expect(slugify("hello\nworld\ttab")).toBe("hello-world-tab");
  });

  // ─── maxLength truncation ──────────────────────────────────────────

  it("does not truncate when maxLength is not provided", () => {
    const long = "a".repeat(200);
    expect(slugify(long)).toBe(long);
  });

  it("truncates to the specified maxLength", () => {
    expect(slugify("a".repeat(100), 60)).toBe("a".repeat(60));
  });

  it("does not truncate when slug is shorter than maxLength", () => {
    expect(slugify("short", 60)).toBe("short");
  });

  it("does not truncate when slug length equals maxLength", () => {
    expect(slugify("a".repeat(50), 50)).toBe("a".repeat(50));
  });

  it("truncates to 50 characters (branch name length)", () => {
    expect(slugify("a".repeat(100), 50)).toBe("a".repeat(50));
  });

  it("handles truncation at a hyphen boundary", () => {
    // "abcde-fghij" with maxLength 5 should produce "abcde"
    expect(slugify("abcde fghij", 5)).toBe("abcde");
  });

  it("handles truncation mid-word", () => {
    // "hello-world" with maxLength 7 should produce "hello-w"
    expect(slugify("hello world", 7)).toBe("hello-w");
  });

  it("handles maxLength of 0", () => {
    expect(slugify("hello", 0)).toBe("");
  });

  it("handles maxLength of 1", () => {
    expect(slugify("hello", 1)).toBe("h");
  });

  // ─── real-world patterns from the codebase ─────────────────────────

  it("produces correct slug for branch name use case (maxLength 50)", () => {
    expect(slugify("Add User Auth", 50)).toBe("add-user-auth");
  });

  it("produces correct slug for filename use case (maxLength 60)", () => {
    expect(slugify("Add User Auth", 60)).toBe("add-user-auth");
  });

  it("produces correct slug for md create use case (no maxLength)", () => {
    expect(slugify("My New Spec Title")).toBe("my-new-spec-title");
  });
});
