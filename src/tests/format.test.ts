import { describe, it, expect } from "vitest";
import { elapsed } from "../format.js";

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
