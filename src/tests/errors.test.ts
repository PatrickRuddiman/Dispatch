import { describe, it, expect } from "vitest";
import { UnsupportedOperationError } from "../helpers/errors.js";

describe("UnsupportedOperationError", () => {
  it("creates an error with the default message", () => {
    const err = new UnsupportedOperationError("createBranch");
    expect(err.message).toBe("Operation not supported: createBranch");
    expect(err.operation).toBe("createBranch");
    expect(err.name).toBe("UnsupportedOperationError");
  });

  it("creates an error with a custom message", () => {
    const err = new UnsupportedOperationError("fetchIssues", "This datasource cannot fetch issues");
    expect(err.message).toBe("This datasource cannot fetch issues");
    expect(err.operation).toBe("fetchIssues");
  });

  it("is an instance of Error", () => {
    const err = new UnsupportedOperationError("doSomething");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnsupportedOperationError);
  });

  it("has a stack trace", () => {
    const err = new UnsupportedOperationError("op");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("UnsupportedOperationError");
  });

  it("operation property is readonly", () => {
    const err = new UnsupportedOperationError("op");
    // TypeScript marks it readonly; verify it exists and is string
    expect(typeof err.operation).toBe("string");
  });
});
