import { describe, it, expect } from "vitest";
import { elapsed, renderHeaderLines } from "../helpers/format.js";

describe("elapsed", () => {
  it("returns '0s' for zero milliseconds", () => {
    expect(elapsed(0)).toBe("0s");
  });

  it("returns '0s' for sub-second durations", () => {
    expect(elapsed(999)).toBe("0s");
  });

  it("formats seconds correctly", () => {
    expect(elapsed(1000)).toBe("1s");
    expect(elapsed(45000)).toBe("45s");
    expect(elapsed(59000)).toBe("59s");
  });

  it("formats minutes and seconds correctly", () => {
    expect(elapsed(60000)).toBe("1m 0s");
    expect(elapsed(61000)).toBe("1m 1s");
    expect(elapsed(133000)).toBe("2m 13s");
  });

  it("handles large durations", () => {
    expect(elapsed(3600000)).toBe("60m 0s");
    expect(elapsed(5400000)).toBe("90m 0s");
  });

  it("truncates fractional milliseconds via Math.floor", () => {
    expect(elapsed(1500)).toBe("1s");
    expect(elapsed(61999)).toBe("1m 1s");
  });
});

describe("renderHeaderLines", () => {
  it("returns the title line when no options are provided", () => {
    const lines = renderHeaderLines({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dispatch");
    expect(lines[0]).toContain("AI task orchestration");
  });

  it("includes provider on its own line when provided", () => {
    const lines = renderHeaderLines({ provider: "opencode" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("provider: opencode");
  });

  it("includes model on its own line when provided", () => {
    const lines = renderHeaderLines({ model: "anthropic/claude-sonnet-4" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("model: anthropic/claude-sonnet-4");
  });

  it("includes source on its own line when provided", () => {
    const lines = renderHeaderLines({ source: "github" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("source: github");
  });

  it("includes all three fields on separate lines when all are provided", () => {
    const lines = renderHeaderLines({
      provider: "opencode",
      model: "anthropic/claude-sonnet-4",
      source: "github",
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("dispatch");
    expect(lines[1]).toContain("provider: opencode");
    expect(lines[2]).toContain("model: anthropic/claude-sonnet-4");
    expect(lines[3]).toContain("source: github");
  });

  it("omits undefined fields", () => {
    const lines = renderHeaderLines({ provider: "copilot", source: "azdevops" });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("dispatch");
    expect(lines[1]).toContain("provider: copilot");
    expect(lines[2]).toContain("source: azdevops");
  });
});
