import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderInstance, ProviderBootOptions } from "../providers/interface.js";

// ─── Hoisted mock references ────────────────────────────────────────

const { mocks } = vi.hoisted(() => {
  const mockBootOpencode = vi.fn<(opts?: ProviderBootOptions) => Promise<ProviderInstance>>();
  const mockBootCopilot = vi.fn<(opts?: ProviderBootOptions) => Promise<ProviderInstance>>();
  const mockBootClaude = vi.fn<(opts?: ProviderBootOptions) => Promise<ProviderInstance>>();
  const mockListOpencode = vi.fn<(opts?: ProviderBootOptions) => Promise<string[]>>();
  const mockListCopilot = vi.fn<(opts?: ProviderBootOptions) => Promise<string[]>>();
  const mockListClaude = vi.fn<(opts?: ProviderBootOptions) => Promise<string[]>>();
  return {
    mocks: {
      mockBootOpencode,
      mockBootCopilot,
      mockBootClaude,
      mockListOpencode,
      mockListCopilot,
      mockListClaude,
    },
  };
});

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("../providers/opencode.js", () => ({
  boot: mocks.mockBootOpencode,
  listModels: mocks.mockListOpencode,
}));

vi.mock("../providers/copilot.js", () => ({
  boot: mocks.mockBootCopilot,
  listModels: mocks.mockListCopilot,
}));

vi.mock("../providers/claude.js", () => ({
  boot: mocks.mockBootClaude,
  listModels: mocks.mockListClaude,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { bootProvider, listProviderModels, PROVIDER_NAMES } from "../providers/index.js";
import type { ProviderName } from "../providers/interface.js";

function createMockProvider(name: string): ProviderInstance {
  return {
    name,
    model: `${name}-model`,
    createSession: vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("session-1"),
    prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("response"),
    cleanup: vi.fn<ProviderInstance["cleanup"]>().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PROVIDER_NAMES", () => {
  it("includes 'opencode', 'copilot', and 'claude'", () => {
    expect(PROVIDER_NAMES).toContain("opencode");
    expect(PROVIDER_NAMES).toContain("copilot");
    expect(PROVIDER_NAMES).toContain("claude");
  });

  it("has exactly three entries", () => {
    expect(PROVIDER_NAMES).toHaveLength(3);
  });

  it("is an array of strings", () => {
    expect(Array.isArray(PROVIDER_NAMES)).toBe(true);
    for (const name of PROVIDER_NAMES) {
      expect(typeof name).toBe("string");
    }
  });
});

describe("bootProvider", () => {
  it("boots the opencode provider", async () => {
    const mock = createMockProvider("opencode");
    mocks.mockBootOpencode.mockResolvedValue(mock);

    const instance = await bootProvider("opencode");

    expect(instance.name).toBe("opencode");
    expect(mocks.mockBootOpencode).toHaveBeenCalledOnce();
  });

  it("boots the copilot provider", async () => {
    const mock = createMockProvider("copilot");
    mocks.mockBootCopilot.mockResolvedValue(mock);

    const instance = await bootProvider("copilot");

    expect(instance.name).toBe("copilot");
    expect(mocks.mockBootCopilot).toHaveBeenCalledOnce();
  });

  it("boots the claude provider", async () => {
    const mock = createMockProvider("claude");
    mocks.mockBootClaude.mockResolvedValue(mock);

    const instance = await bootProvider("claude");

    expect(instance.name).toBe("claude");
    expect(mocks.mockBootClaude).toHaveBeenCalledOnce();
  });

  it("passes options to the boot function", async () => {
    const mock = createMockProvider("opencode");
    mocks.mockBootOpencode.mockResolvedValue(mock);
    const opts: ProviderBootOptions = { url: "http://localhost:3000", cwd: "/tmp" };

    await bootProvider("opencode", opts);

    expect(mocks.mockBootOpencode).toHaveBeenCalledWith(opts);
  });

  it("returns the provider instance from the boot function", async () => {
    const mock = createMockProvider("opencode");
    mocks.mockBootOpencode.mockResolvedValue(mock);

    const instance = await bootProvider("opencode");

    expect(instance).toBe(mock);
  });

  it("throws for unknown provider name", async () => {
    await expect(bootProvider("unknown" as ProviderName)).rejects.toThrow(
      'Unknown provider "unknown"',
    );
  });

  it("includes available providers in error message", async () => {
    await expect(bootProvider("unknown" as ProviderName)).rejects.toThrow("opencode");
    await expect(bootProvider("unknown" as ProviderName)).rejects.toThrow("copilot");
  });

  it("propagates errors from the boot function", async () => {
    mocks.mockBootOpencode.mockRejectedValue(new Error("connection failed"));

    await expect(bootProvider("opencode")).rejects.toThrow("connection failed");
  });
});

describe("listProviderModels", () => {
  it("returns model list from the underlying provider", async () => {
    const models = ["model-a", "model-b"];
    mocks.mockListOpencode.mockResolvedValue(models);

    const result = await listProviderModels("opencode");

    expect(result).toEqual(models);
    expect(mocks.mockListOpencode).toHaveBeenCalledOnce();
  });

  it("passes options to the list function", async () => {
    mocks.mockListCopilot.mockResolvedValue([]);
    const opts: ProviderBootOptions = { url: "http://localhost:3000" };

    await listProviderModels("copilot", opts);

    expect(mocks.mockListCopilot).toHaveBeenCalledWith(opts);
  });

  it("throws for unknown provider name", async () => {
    await expect(listProviderModels("unknown" as ProviderName)).rejects.toThrow(
      'Unknown provider "unknown"',
    );
  });

  it("propagates errors from the list function", async () => {
    mocks.mockListClaude.mockRejectedValue(new Error("service unavailable"));

    await expect(listProviderModels("claude")).rejects.toThrow("service unavailable");
  });
});
