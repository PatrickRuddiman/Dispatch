import { describe, it, expect } from "vitest";
import { parseAzDevOpsRemoteUrl, parseGitHubRemoteUrl } from "../datasources/index.js";

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

// ─── parseGitHubRemoteUrl ────────────────────────────────────────────

describe("parseGitHubRemoteUrl", () => {
  it("parses HTTPS URL with .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "https://github.com/owner/repo.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS URL without .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "https://github.com/owner/repo",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses SSH URL with .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "git@github.com:owner/repo.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses SSH URL without .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "git@github.com:owner/repo",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for Azure DevOps URLs", () => {
    expect(
      parseGitHubRemoteUrl("https://dev.azure.com/org/project/_git/repo"),
    ).toBeNull();
  });

  it("returns null for non-GitHub URLs", () => {
    expect(
      parseGitHubRemoteUrl("https://gitlab.com/user/repo.git"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGitHubRemoteUrl("")).toBeNull();
  });

  it("handles owner and repo names with hyphens and numbers", () => {
    const result = parseGitHubRemoteUrl(
      "https://github.com/my-org/my-repo-123.git",
    );
    expect(result).toEqual({ owner: "my-org", repo: "my-repo-123" });
  });

  it("handles HTTPS URL with trailing slash", () => {
    const result = parseGitHubRemoteUrl(
      "https://github.com/owner/repo/",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("handles HTTPS URL with repo name containing dots", () => {
    const result = parseGitHubRemoteUrl(
      "https://github.com/owner/my.repo.name.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "my.repo.name" });
  });

  it("handles HTTPS URL without .git and repo name containing dots", () => {
    const result = parseGitHubRemoteUrl(
      "https://github.com/owner/my.repo.name",
    );
    expect(result).toEqual({ owner: "owner", repo: "my.repo.name" });
  });

  it("handles SSH URL with repo name containing dots", () => {
    const result = parseGitHubRemoteUrl(
      "git@github.com:owner/my.repo.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "my.repo" });
  });

  it("parses ssh:// URL with .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "ssh://git@github.com/owner/repo.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses ssh:// URL without .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "ssh://git@github.com/owner/repo",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  // ── Fix 2: HTTPS URLs with userinfo (credentials) ──────────────
  it("parses HTTPS URL with userinfo (user@host)", () => {
    const result = parseGitHubRemoteUrl(
      "https://user@github.com/owner/repo.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS URL with user:password userinfo", () => {
    const result = parseGitHubRemoteUrl(
      "https://user:token@github.com/owner/repo.git",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS URL with PAT token as userinfo", () => {
    const result = parseGitHubRemoteUrl(
      "https://x-access-token:ghp_abc123@github.com/myorg/myrepo",
    );
    expect(result).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("parses HTTPS URL with userinfo and without .git suffix", () => {
    const result = parseGitHubRemoteUrl(
      "https://oauth2:token@github.com/owner/repo",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });
});
