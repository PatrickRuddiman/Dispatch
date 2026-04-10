import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent, AgentBootOptions } from "../agents/interface.js";

// ─── Module mocks ───────────────────────────────────────────────────

const { mockBootPlanner, mockBootExecutor, mockBootSpec } = vi.hoisted(() => ({
  mockBootPlanner: vi.fn<(opts: AgentBootOptions) => Promise<Agent>>(),
  mockBootExecutor: vi.fn<(opts: AgentBootOptions) => Promise<Agent>>(),
  mockBootSpec: vi.fn<(opts: AgentBootOptions) => Promise<Agent>>(),
}));

vi.mock("../agents/planner.js", () => ({
  boot: mockBootPlanner,
}));

vi.mock("../agents/executor.js", () => ({
  boot: mockBootExecutor,
}));

vi.mock("../agents/spec.js", () => ({
  boot: mockBootSpec,
}));

import {
  AGENT_NAMES,
  bootAgent,
  bootPlanner,
  bootExecutor,
  bootSpec,
} from "../agents/index.js";

// ─── Helpers ────────────────────────────────────────────────────────

function fakeAgent(name: string): Agent {
  return { name, cleanup: vi.fn() };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("AGENT_NAMES", () => {
  it("contains all registered agent names", () => {
    expect(AGENT_NAMES).toContain("planner");
    expect(AGENT_NAMES).toContain("executor");
    expect(AGENT_NAMES).toContain("spec");
    expect(AGENT_NAMES).toContain("commit");
    expect(AGENT_NAMES).toHaveLength(4);
  });

  it("is an array of strings", () => {
    for (const name of AGENT_NAMES) {
      expect(typeof name).toBe("string");
    }
  });
});

describe("bootAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("boots a planner agent by name", async () => {
    mockBootPlanner.mockResolvedValue(fakeAgent("planner"));
    const agent = await bootAgent("planner", { cwd: "/tmp" });
    expect(agent.name).toBe("planner");
    expect(mockBootPlanner).toHaveBeenCalledOnce();
    expect(mockBootPlanner).toHaveBeenCalledWith({ cwd: "/tmp" });
  });

  it("boots an executor agent by name", async () => {
    mockBootExecutor.mockResolvedValue(fakeAgent("executor"));
    const agent = await bootAgent("executor", { cwd: "/tmp" });
    expect(agent.name).toBe("executor");
    expect(mockBootExecutor).toHaveBeenCalledOnce();
    expect(mockBootExecutor).toHaveBeenCalledWith({ cwd: "/tmp" });
  });

  it("boots a spec agent by name", async () => {
    mockBootSpec.mockResolvedValue(fakeAgent("spec"));
    const agent = await bootAgent("spec", { cwd: "/tmp" });
    expect(agent.name).toBe("spec");
    expect(mockBootSpec).toHaveBeenCalledOnce();
    expect(mockBootSpec).toHaveBeenCalledWith({ cwd: "/tmp" });
  });

  it("passes boot options through to the underlying boot function", async () => {
    const mockProvider = {
      name: "mock",
      model: "m",
      createSession: vi.fn(),
      prompt: vi.fn(),
      cleanup: vi.fn(),
    };
    mockBootPlanner.mockResolvedValue(fakeAgent("planner"));
    await bootAgent("planner", { cwd: "/work", provider: mockProvider });
    expect(mockBootPlanner).toHaveBeenCalledWith({
      cwd: "/work",
      provider: mockProvider,
    });
  });

  it("throws for an unknown agent name", async () => {
    await expect(
      bootAgent("unknown" as any, { cwd: "/tmp" })
    ).rejects.toThrow(/Unknown agent "unknown"/);
  });

  it("returns the agent instance from the underlying boot function", async () => {
    const expected = fakeAgent("planner");
    mockBootPlanner.mockResolvedValue(expected);
    const result = await bootAgent("planner", { cwd: "/tmp" });
    expect(result).toBe(expected);
  });
});

describe("re-exported boot functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bootPlanner is the planner boot function", async () => {
    expect(typeof bootPlanner).toBe("function");
    mockBootPlanner.mockResolvedValue(fakeAgent("planner"));
    await bootPlanner({ cwd: "/tmp" });
    expect(mockBootPlanner).toHaveBeenCalledOnce();
  });

  it("bootExecutor is the executor boot function", async () => {
    expect(typeof bootExecutor).toBe("function");
    mockBootExecutor.mockResolvedValue(fakeAgent("executor"));
    await bootExecutor({ cwd: "/tmp" });
    expect(mockBootExecutor).toHaveBeenCalledOnce();
  });

  it("bootSpec is the spec boot function", async () => {
    expect(typeof bootSpec).toBe("function");
    mockBootSpec.mockResolvedValue(fakeAgent("spec"));
    await bootSpec({ cwd: "/tmp" });
    expect(mockBootSpec).toHaveBeenCalledOnce();
  });
});
