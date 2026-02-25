import { describe, it, expect } from "vitest";
import { isIssueNumbers } from "./spec-generator.js";

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
});
