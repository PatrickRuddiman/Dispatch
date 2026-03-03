import { describe, it, expect } from "vitest";
import { parseAzDevOpsRemoteUrl } from "../datasources/index.js";

// ─── parseAzDevOpsRemoteUrl ──────────────────────────────────────────

describe("parseAzDevOpsRemoteUrl", () => {
  it("parses HTTPS dev.azure.com URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://dev.azure.com/myorg/my-project/_git/my-repo",
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "my-project",
    });
  });

  it("parses SSH dev.azure.com URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "git@ssh.dev.azure.com:v3/myorg/my-project/my-repo",
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "my-project",
    });
  });

  it("parses legacy visualstudio.com URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://myorg.visualstudio.com/my-project/_git/my-repo",
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/myorg",
      project: "my-project",
    });
  });

  it("returns null for GitHub URLs", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://github.com/user/repo.git"),
    ).toBeNull();
  });

  it("returns null for non-Azure DevOps URLs", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://gitlab.com/user/repo.git"),
    ).toBeNull();
  });

  it("returns null for malformed Azure DevOps URL missing project", () => {
    expect(
      parseAzDevOpsRemoteUrl("https://dev.azure.com/orgonly"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAzDevOpsRemoteUrl("")).toBeNull();
  });

  it("handles org and project names with hyphens and numbers", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://dev.azure.com/my-org/my-project-123/_git/repo",
    );
    expect(result).toEqual({
      orgUrl: "https://dev.azure.com/my-org",
      project: "my-project-123",
    });
  });

  it("normalizes legacy visualstudio.com to dev.azure.com org URL", () => {
    const result = parseAzDevOpsRemoteUrl(
      "https://contoso.visualstudio.com/WebApp/_git/WebApp",
    );
    expect(result?.orgUrl).toBe("https://dev.azure.com/contoso");
    expect(result?.project).toBe("WebApp");
  });
});
