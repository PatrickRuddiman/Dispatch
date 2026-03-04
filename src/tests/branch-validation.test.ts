import { describe, it, expect } from "vitest";
import {
  isValidBranchName,
  InvalidBranchNameError,
  VALID_BRANCH_NAME_RE,
} from "../helpers/branch-validation.js";

describe("isValidBranchName", () => {
  describe("valid branch names", () => {
    it("accepts simple name", () => {
      expect(isValidBranchName("main")).toBe(true);
    });

    it("accepts name with slash", () => {
      expect(isValidBranchName("feature/add-auth")).toBe(true);
    });

    it("accepts typical dispatch branch format", () => {
      expect(isValidBranchName("user/dispatch/42-add-auth")).toBe(true);
    });

    it("accepts dots", () => {
      expect(isValidBranchName("release/2024.1")).toBe(true);
    });

    it("accepts single character", () => {
      expect(isValidBranchName("a")).toBe(true);
    });

    it("accepts maximum length (255 chars)", () => {
      expect(isValidBranchName("a".repeat(255))).toBe(true);
    });

    it("accepts underscores", () => {
      expect(isValidBranchName("my-branch_name")).toBe(true);
    });

    it("accepts version-like name", () => {
      expect(isValidBranchName("v1.0.0")).toBe(true);
    });
  });

  describe("empty and overlength", () => {
    it("rejects empty string", () => {
      expect(isValidBranchName("")).toBe(false);
    });

    it("rejects names exceeding 255 chars", () => {
      expect(isValidBranchName("a".repeat(256))).toBe(false);
    });
  });

  describe("invalid characters", () => {
    it("rejects spaces", () => {
      expect(isValidBranchName("my branch")).toBe(false);
    });

    it("rejects colon", () => {
      expect(isValidBranchName("feat: add")).toBe(false);
    });

    it("rejects shell metacharacters", () => {
      expect(isValidBranchName("$(whoami)")).toBe(false);
    });

    it("rejects tilde", () => {
      expect(isValidBranchName("branch~1")).toBe(false);
    });

    it("rejects caret", () => {
      expect(isValidBranchName("branch^2")).toBe(false);
    });

    it("rejects backslash", () => {
      expect(isValidBranchName("branch\\path")).toBe(false);
    });

    it("rejects tab", () => {
      expect(isValidBranchName("name with\ttab")).toBe(false);
    });

    it("rejects question mark", () => {
      expect(isValidBranchName("branch?name")).toBe(false);
    });

    it("rejects asterisk", () => {
      expect(isValidBranchName("branch*name")).toBe(false);
    });

    it("rejects square brackets", () => {
      expect(isValidBranchName("branch[0]")).toBe(false);
    });

    it("rejects newline", () => {
      expect(isValidBranchName("branch name\n")).toBe(false);
    });
  });

  describe("git refname structural rules", () => {
    it("rejects leading slash", () => {
      expect(isValidBranchName("/leading-slash")).toBe(false);
    });

    it("rejects trailing slash", () => {
      expect(isValidBranchName("trailing-slash/")).toBe(false);
    });

    it("rejects double dots (parent traversal)", () => {
      expect(isValidBranchName("a..b")).toBe(false);
    });

    it("rejects names ending with .lock", () => {
      expect(isValidBranchName("branch.lock")).toBe(false);
    });

    it("rejects refs.lock", () => {
      expect(isValidBranchName("refs.lock")).toBe(false);
    });

    it("rejects @{ reflog syntax", () => {
      expect(isValidBranchName("branch@{0}")).toBe(false);
    });

    it("rejects @{yesterday}", () => {
      expect(isValidBranchName("main@{yesterday}")).toBe(false);
    });

    it("rejects double slashes", () => {
      expect(isValidBranchName("a//b")).toBe(false);
    });
  });
});

describe("InvalidBranchNameError", () => {
  it("is an instance of Error", () => {
    const err = new InvalidBranchNameError("bad");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name set to InvalidBranchNameError", () => {
    const err = new InvalidBranchNameError("bad");
    expect(err.name).toBe("InvalidBranchNameError");
  });

  it("includes branch name in message", () => {
    const err = new InvalidBranchNameError("bad");
    expect(err.message).toContain("bad");
  });

  it("includes reason when provided", () => {
    const err = new InvalidBranchNameError("bad", "from symbolic-ref output");
    expect(err.message).toContain("from symbolic-ref output");
  });

  it("works without reason", () => {
    const err = new InvalidBranchNameError("bad");
    expect(err.message).toBe('Invalid branch name: "bad"');
  });
});

describe("VALID_BRANCH_NAME_RE", () => {
  it("matches alphanumeric with dots, hyphens, underscores, slashes", () => {
    expect(VALID_BRANCH_NAME_RE.test("abc/def-ghi_jkl.mno")).toBe(true);
  });

  it("rejects spaces", () => {
    expect(VALID_BRANCH_NAME_RE.test("a b")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(VALID_BRANCH_NAME_RE.test("a@b")).toBe(false);
    expect(VALID_BRANCH_NAME_RE.test("a:b")).toBe(false);
    expect(VALID_BRANCH_NAME_RE.test("a[b]")).toBe(false);
  });
});
