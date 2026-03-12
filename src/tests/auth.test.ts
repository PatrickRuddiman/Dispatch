import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}));

const mockHomedir = vi.hoisted(() => vi.fn(() => "/fakehome"));

const mockOctokitInstance = vi.hoisted(() => ({}));
const mockOctokitConstructor = vi.hoisted(() =>
  vi.fn(function () {
    return mockOctokitInstance;
  }),
);

const mockAuthFn = vi.hoisted(() => vi.fn());
const mockCreateOAuthDeviceAuth = vi.hoisted(
  () => vi.fn(() => mockAuthFn),
);

const mockGetToken = vi.hoisted(() => vi.fn());
const mockDeviceCodeCredential = vi.hoisted(() =>
  vi.fn(function () {
    return { getToken: mockGetToken };
  }),
);

const mockWebApiInstance = vi.hoisted(() => ({}));
const mockWebApi = vi.hoisted(() =>
  vi.fn(function () {
    return mockWebApiInstance;
  }),
);
const mockGetBearerHandler = vi.hoisted(
  () => vi.fn(() => "bearer-handler"),
);

const mockOpen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockGetGitRemoteUrl = vi.hoisted(() => vi.fn());
const mockParseGitHubRemoteUrl = vi.hoisted(() => vi.fn());
const mockParseAzDevOpsRemoteUrl = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  readFile: mockFs.readFile,
  writeFile: mockFs.writeFile,
  mkdir: mockFs.mkdir,
  chmod: mockFs.chmod,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: mockOctokitConstructor,
}));

vi.mock("@octokit/auth-oauth-device", () => ({
  createOAuthDeviceAuth: mockCreateOAuthDeviceAuth,
}));

vi.mock("@azure/identity", () => ({
  DeviceCodeCredential: mockDeviceCodeCredential,
}));

vi.mock("azure-devops-node-api", () => ({
  WebApi: mockWebApi,
  getBearerHandler: mockGetBearerHandler,
}));

vi.mock("open", () => ({ default: mockOpen }));

vi.mock("../datasources/index.js", () => ({
  getGitRemoteUrl: mockGetGitRemoteUrl,
  parseGitHubRemoteUrl: mockParseGitHubRemoteUrl,
  parseAzDevOpsRemoteUrl: mockParseAzDevOpsRemoteUrl,
}));

vi.mock("../helpers/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getGithubOctokit, getAzureConnection, setAuthPromptHandler, ensureAuthReady } from "../helpers/auth.js";

const realPlatform = process.platform;

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue("/fakehome");
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.chmod.mockResolvedValue(undefined);
  mockOpen.mockResolvedValue(undefined);
  setAuthPromptHandler(null);
});

describe("getGithubOctokit", () => {
  it("returns cached Octokit when valid GitHub token exists", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ github: { token: "gh-cached-token" } }),
    );

    const result = await getGithubOctokit();

    expect(mockOctokitConstructor).toHaveBeenCalledWith({
      auth: "gh-cached-token",
    });
    expect(mockCreateOAuthDeviceAuth).not.toHaveBeenCalled();
    expect(result).toBe(mockOctokitInstance);
  });

  it("initiates device flow when no cached token exists", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockAuthFn.mockResolvedValue({ token: "gh-new-token" });

    const result = await getGithubOctokit();

    expect(mockCreateOAuthDeviceAuth).toHaveBeenCalledOnce();
    expect(mockCreateOAuthDeviceAuth).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "Ov23liUMP1Oyg811IF58" }),
    );
    expect(mockAuthFn).toHaveBeenCalledWith({ type: "oauth" });

    expect(mockFs.writeFile).toHaveBeenCalledOnce();
    const [writePath, writeData] = mockFs.writeFile.mock.calls[0];
    expect(writePath).toBe(join("/fakehome", ".dispatch", "auth.json"));
    const parsed = JSON.parse(writeData);
    expect(parsed.github).toEqual({ token: "gh-new-token" });

    if (realPlatform !== "win32") {
      expect(mockFs.chmod).toHaveBeenCalledWith(
        join("/fakehome", ".dispatch", "auth.json"),
        0o600,
      );
    }
    expect(mockOctokitConstructor).toHaveBeenCalledWith({
      auth: "gh-new-token",
    });
    expect(result).toBe(mockOctokitInstance);
  });

  it("initiates device flow when auth.json exists but has no github key", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        azure: { token: "az-tok", expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
    mockAuthFn.mockResolvedValue({ token: "gh-new-token" });

    await getGithubOctokit();

    expect(mockCreateOAuthDeviceAuth).toHaveBeenCalledOnce();

    const [, writeData] = mockFs.writeFile.mock.calls[0];
    const parsed = JSON.parse(writeData);
    expect(parsed.github).toEqual({ token: "gh-new-token" });
    expect(parsed.azure).toEqual({
      token: "az-tok",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
});

describe("getAzureConnection", () => {
  it("returns cached connection when valid Azure token exists", async () => {
    const futureExpiry = new Date(
      Date.now() + 60 * 60 * 1000,
    ).toISOString();
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        azure: { token: "az-cached-token", expiresAt: futureExpiry },
      }),
    );

    const result = await getAzureConnection("https://dev.azure.com/myorg");

    expect(mockGetBearerHandler).toHaveBeenCalledWith("az-cached-token");
    expect(mockWebApi).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg",
      "bearer-handler",
    );
    expect(mockDeviceCodeCredential).not.toHaveBeenCalled();
    expect(result).toBe(mockWebApiInstance);
  });

  it("initiates device flow when no cached Azure token exists", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockGetToken.mockResolvedValue({
      token: "az-new-token",
      expiresOnTimestamp: Date.now() + 3600000,
    });

    const result = await getAzureConnection("https://dev.azure.com/myorg");

    expect(mockDeviceCodeCredential).toHaveBeenCalledOnce();
    expect(mockGetToken).toHaveBeenCalledWith(
      "499b84ac-1321-427f-aa17-267ca6975798/.default",
    );

    expect(mockFs.writeFile).toHaveBeenCalledOnce();
    const [writePath, writeData] = mockFs.writeFile.mock.calls[0];
    expect(writePath).toBe(join("/fakehome", ".dispatch", "auth.json"));
    const parsed = JSON.parse(writeData);
    expect(parsed.azure.token).toBe("az-new-token");
    expect(parsed.azure.expiresAt).toBeDefined();

    if (realPlatform !== "win32") {
      expect(mockFs.chmod).toHaveBeenCalledWith(
        join("/fakehome", ".dispatch", "auth.json"),
        0o600,
      );
    }
    expect(mockWebApi).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg",
      "bearer-handler",
    );
    expect(result).toBe(mockWebApiInstance);
  });

  it("refreshes token when cached Azure token is expired", async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        azure: { token: "az-expired-token", expiresAt: pastExpiry },
      }),
    );
    mockGetToken.mockResolvedValue({
      token: "az-refreshed-token",
      expiresOnTimestamp: Date.now() + 3600000,
    });

    await getAzureConnection("https://dev.azure.com/myorg");

    expect(mockDeviceCodeCredential).toHaveBeenCalledOnce();
    expect(mockGetBearerHandler).toHaveBeenCalledWith("az-refreshed-token");

    const [, writeData] = mockFs.writeFile.mock.calls[0];
    const parsed = JSON.parse(writeData);
    expect(parsed.azure.token).toBe("az-refreshed-token");
  });

  it("refreshes token when cached Azure token is within expiry buffer", async () => {
    const nearExpiry = new Date(
      Date.now() + 2 * 60 * 1000,
    ).toISOString();
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        azure: { token: "az-almost-expired", expiresAt: nearExpiry },
      }),
    );
    mockGetToken.mockResolvedValue({
      token: "az-refreshed-token",
      expiresOnTimestamp: Date.now() + 3600000,
    });

    await getAzureConnection("https://dev.azure.com/myorg");

    expect(mockDeviceCodeCredential).toHaveBeenCalledOnce();
  });
});

describe("auth cache file operations", () => {
  it("creates directory with mkdir recursive before writing", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockAuthFn.mockResolvedValue({ token: "tok" });

    await getGithubOctokit();

    expect(mockFs.mkdir).toHaveBeenCalledWith(join("/fakehome", ".dispatch"), {
      recursive: true,
    });
  });

  it.skipIf(realPlatform === "win32")("sets file permissions to 0o600 after writing on non-Windows", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockAuthFn.mockResolvedValue({ token: "tok" });

    await getGithubOctokit();

    expect(mockFs.chmod).toHaveBeenCalledWith(
      join("/fakehome", ".dispatch", "auth.json"),
      0o600,
    );
  });

  it("skips chmod on Windows platform", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockAuthFn.mockResolvedValue({ token: "tok" });

    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    try {
      await getGithubOctokit();
      expect(mockFs.chmod).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: realPlatform,
        configurable: true,
      });
    }
  });
});

describe("auth prompt handler", () => {
  it("routes GitHub device-code prompt to handler when set", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockAuthFn.mockResolvedValue({ token: "gh-new-token" });

    const handler = vi.fn();
    setAuthPromptHandler(handler);

    await getGithubOctokit();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createCall = (mockCreateOAuthDeviceAuth.mock.calls as any)[0][0];
    createCall.onVerification({
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
    });

    expect(handler).toHaveBeenCalledWith(
      "Enter code ABCD-1234 at https://github.com/login/device",
    );
  });

  it("routes Azure device-code prompt to handler when set", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockGetToken.mockResolvedValue({
      token: "az-new-token",
      expiresOnTimestamp: Date.now() + 3600000,
    });

    const handler = vi.fn();
    setAuthPromptHandler(handler);

    await getAzureConnection("https://dev.azure.com/myorg");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentialCall = (mockDeviceCodeCredential.mock.calls as any)[0][0];
    credentialCall.userPromptCallback({
      message: "To sign in, use a web browser...",
      verificationUri: "https://microsoft.com/devicelogin",
    });

    expect(handler).toHaveBeenCalledWith(
      "Azure DevOps requires a work or school account (personal Microsoft accounts are not supported).\nTo sign in, use a web browser...",
    );
  });

  it("falls back to log.info when no handler is set", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockAuthFn.mockResolvedValue({ token: "gh-new-token" });

    setAuthPromptHandler(null);

    await getGithubOctokit();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createCall = (mockCreateOAuthDeviceAuth.mock.calls as any)[0][0];
    createCall.onVerification({
      user_code: "WXYZ-5678",
      verification_uri: "https://github.com/login/device",
    });

    // log.info is mocked — import it to verify it was called
    const { log } = await import("../helpers/logger.js");
    expect(log.info).toHaveBeenCalledWith(
      "Enter code WXYZ-5678 at https://github.com/login/device",
    );
  });
});

describe("ensureAuthReady", () => {
  it("authenticates GitHub when source is github and remote is valid", async () => {
    mockGetGitRemoteUrl.mockResolvedValue("https://github.com/owner/repo");
    mockParseGitHubRemoteUrl.mockReturnValue({ owner: "owner", repo: "repo" });
    mockFs.readFile.mockResolvedValue(JSON.stringify({ github: { token: "cached" } }));

    await ensureAuthReady("github", "/fake/cwd");

    expect(mockGetGitRemoteUrl).toHaveBeenCalledWith("/fake/cwd");
    expect(mockParseGitHubRemoteUrl).toHaveBeenCalledWith("https://github.com/owner/repo");
    expect(mockOctokitConstructor).toHaveBeenCalledWith({ auth: "cached" });
  });

  it("skips GitHub auth when no remote is found", async () => {
    mockGetGitRemoteUrl.mockResolvedValue(null);

    await ensureAuthReady("github", "/fake/cwd");

    expect(mockOctokitConstructor).not.toHaveBeenCalled();
    const { log } = await import("../helpers/logger.js");
    expect(log.warn).toHaveBeenCalledWith("No git remote found — skipping GitHub pre-authentication");
  });

  it("skips GitHub auth when remote is not a GitHub URL", async () => {
    mockGetGitRemoteUrl.mockResolvedValue("https://gitlab.com/owner/repo");
    mockParseGitHubRemoteUrl.mockReturnValue(null);

    await ensureAuthReady("github", "/fake/cwd");

    expect(mockOctokitConstructor).not.toHaveBeenCalled();
    const { log } = await import("../helpers/logger.js");
    expect(log.warn).toHaveBeenCalledWith("Remote URL is not a GitHub repository — skipping GitHub pre-authentication");
  });

  it("authenticates Azure DevOps when source is azdevops with explicit org", async () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ azure: { token: "az-cached", expiresAt: futureExpiry } }),
    );

    await ensureAuthReady("azdevops", "/fake/cwd", "https://dev.azure.com/myorg");

    expect(mockGetGitRemoteUrl).not.toHaveBeenCalled();
    expect(mockWebApi).toHaveBeenCalledWith("https://dev.azure.com/myorg", "bearer-handler");
  });

  it("resolves Azure org from remote when not explicitly provided", async () => {
    mockGetGitRemoteUrl.mockResolvedValue("https://dev.azure.com/myorg/myproject/_git/myrepo");
    mockParseAzDevOpsRemoteUrl.mockReturnValue({ orgUrl: "https://dev.azure.com/myorg", project: "myproject" });
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ azure: { token: "az-cached", expiresAt: futureExpiry } }),
    );

    await ensureAuthReady("azdevops", "/fake/cwd");

    expect(mockGetGitRemoteUrl).toHaveBeenCalledWith("/fake/cwd");
    expect(mockParseAzDevOpsRemoteUrl).toHaveBeenCalledWith("https://dev.azure.com/myorg/myproject/_git/myrepo");
    expect(mockWebApi).toHaveBeenCalledWith("https://dev.azure.com/myorg", "bearer-handler");
  });

  it("skips Azure auth when org cannot be resolved", async () => {
    mockGetGitRemoteUrl.mockResolvedValue(null);

    await ensureAuthReady("azdevops", "/fake/cwd");

    expect(mockWebApi).not.toHaveBeenCalled();
  });

  it("does nothing for md datasource", async () => {
    await ensureAuthReady("md", "/fake/cwd");

    expect(mockGetGitRemoteUrl).not.toHaveBeenCalled();
    expect(mockOctokitConstructor).not.toHaveBeenCalled();
    expect(mockWebApi).not.toHaveBeenCalled();
  });

  it("does nothing when source is undefined", async () => {
    await ensureAuthReady(undefined, "/fake/cwd");

    expect(mockGetGitRemoteUrl).not.toHaveBeenCalled();
    expect(mockOctokitConstructor).not.toHaveBeenCalled();
    expect(mockWebApi).not.toHaveBeenCalled();
  });
});
