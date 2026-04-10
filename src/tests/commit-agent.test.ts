import { describe, it, expect, vi } from "vitest";
import type { ProviderInstance } from "../providers/interface.js";
import { boot, buildCommitPrompt } from "../agents/commit.js";

function createMockProvider(overrides?: Partial<ProviderInstance>): ProviderInstance {
  return {
    name: "mock",
    model: "mock-model",
    createSession: vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("session-1"),
    prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done"),
    cleanup: vi.fn<ProviderInstance["cleanup"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("boot", () => {
  it("throws when provider is not supplied", async () => {
    await expect(boot({ cwd: "/tmp" })).rejects.toThrow(
      "Commit agent requires a provider instance in boot options"
    );
  });

  it("returns an agent with name 'commit'", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(agent.name).toBe("commit");
  });

  it("returns an agent with cleanup method", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    expect(typeof agent.cleanup).toBe("function");
  });
});

describe("cleanup", () => {
  it("resolves without error", async () => {
    const provider = createMockProvider();
    const agent = await boot({ cwd: "/tmp", provider });
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });
});

describe("buildCommitPrompt", () => {
  it("includes the environment section", () => {
    const prompt = buildCommitPrompt({
      branchDiff: "diff --git a/file.ts b/file.ts",
      issue: { number: "1", title: "Test issue", body: "", labels: [], url: "", state: "open", comments: [], acceptanceCriteria: "" },
      taskResults: [],
      cwd: "/tmp/test",
    });
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });
});
