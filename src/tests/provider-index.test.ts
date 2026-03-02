import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderInstance, ProviderBootOptions } from "../providers/interface.js";

// ─── Hoisted mock references ────────────────────────────────────────

const { mocks } = vi.hoisted(() => {
  const mockBootOpencode = vi.fn<(opts?: ProviderBootOptions) => Promise<ProviderInstance>>();
  const mockBootCopilot = vi.fn<(opts?: ProviderBootOptions) => Promise<ProviderInstance>>();
  return { mocks: { mockBootOpencode, mockBootCopilot } };
});

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock("../providers/opencode.js", () => ({
  boot: mocks.mockBootOpencode,
}));

vi.mock("../providers/copilot.js", () => ({
  boot: mocks.mockBootCopilot,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { bootProvider, PROVIDER_NAMES } from "../providers/index.js";
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
  it("includes 'opencode' and 'copilot'", () => {
    expect(PROVIDER_NAMES).toContain("opencode");
    expect(PROVIDER_NAMES).toContain("copilot");
  });

  it("has exactly two entries", () => {
    expect(PROVIDER_NAMES).toHaveLength(2);
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
