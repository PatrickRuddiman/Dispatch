import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCheckAuth = vi.fn();

vi.mock("../providers/registry.js", () => ({
  PROVIDER_REGISTRY: new Proxy(
    {},
    {
      get: () => ({ checkAuth: mockCheckAuth }),
    },
  ),
}));

import { checkProviderAuthenticated, getProviderAuthStatus, getAuthenticatedProviders } from "../providers/detect.js";

beforeEach(() => {
  mockCheckAuth.mockReset();
});

describe("checkProviderAuthenticated", () => {
  it("returns true when checkAuth returns authenticated", async () => {
    mockCheckAuth.mockResolvedValue({ status: "authenticated" });

    expect(await checkProviderAuthenticated("claude")).toBe(true);
  });

  it("returns false when checkAuth returns not-configured", async () => {
    mockCheckAuth.mockResolvedValue({ status: "not-configured", hint: "Run claude login" });

    expect(await checkProviderAuthenticated("claude")).toBe(false);
  });
});

describe("getProviderAuthStatus", () => {
  it("returns the full AuthStatus object", async () => {
    const status = { status: "expired" as const, hint: "Token expired" };
    mockCheckAuth.mockResolvedValue(status);

    expect(await getProviderAuthStatus("claude")).toEqual(status);
  });
});

describe("getAuthenticatedProviders", () => {
  it("filters to only authenticated providers", async () => {
    mockCheckAuth
      .mockResolvedValueOnce({ status: "authenticated" })
      .mockResolvedValueOnce({ status: "not-configured", hint: "missing" })
      .mockResolvedValueOnce({ status: "authenticated" });

    const result = await getAuthenticatedProviders(["claude", "copilot", "codex"]);

    expect(result).toEqual(["claude", "codex"]);
  });
});
