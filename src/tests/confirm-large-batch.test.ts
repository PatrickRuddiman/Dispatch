import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────

const { mockInput } = vi.hoisted(() => ({
  mockInput: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  input: mockInput,
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    verbose: false,
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    task: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
    formatErrorChain: vi.fn((e: unknown) => String(e)),
  },
}));

// ── Imports ─────────────────────────────────────────────────────────

import {
  confirmLargeBatch,
  LARGE_BATCH_THRESHOLD,
} from "../helpers/confirm-large-batch.js";
import { log } from "../helpers/logger.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("confirmLargeBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports LARGE_BATCH_THRESHOLD as 100", () => {
    expect(LARGE_BATCH_THRESHOLD).toBe(100);
  });

  // ── When count is at or below threshold ───────────────────────────

  describe("when count is at or below threshold", () => {
    it("returns true when count equals threshold", async () => {
      const result = await confirmLargeBatch(100);
      expect(result).toBe(true);
      expect(mockInput).not.toHaveBeenCalled();
    });

    it("returns true when count is below threshold", async () => {
      const result = await confirmLargeBatch(50);
      expect(result).toBe(true);
      expect(mockInput).not.toHaveBeenCalled();
    });
  });

  // ── When count exceeds threshold ──────────────────────────────────

  describe("when count exceeds threshold", () => {
    it("prompts and returns true when user types 'yes'", async () => {
      mockInput.mockResolvedValue("yes");
      const result = await confirmLargeBatch(101);
      expect(result).toBe(true);
      expect(mockInput).toHaveBeenCalled();
    });

    it("returns false when user types anything other than 'yes'", async () => {
      mockInput.mockResolvedValue("no");
      const result = await confirmLargeBatch(101);
      expect(result).toBe(false);
    });

    it("returns false when user types empty string", async () => {
      mockInput.mockResolvedValue("");
      const result = await confirmLargeBatch(101);
      expect(result).toBe(false);
    });

    it("accepts 'yes' case-insensitively", async () => {
      mockInput.mockResolvedValue("YES");
      expect(await confirmLargeBatch(101)).toBe(true);

      mockInput.mockResolvedValue("Yes");
      expect(await confirmLargeBatch(101)).toBe(true);
    });

    it("trims whitespace from user input", async () => {
      mockInput.mockResolvedValue("  yes  ");
      const result = await confirmLargeBatch(101);
      expect(result).toBe(true);
    });

    it("calls log.warn with the item count when prompting", async () => {
      mockInput.mockResolvedValue("yes");
      await confirmLargeBatch(150);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("150"),
      );
    });
  });

  // ── Custom threshold ──────────────────────────────────────────────

  describe("custom threshold", () => {
    it("prompts when count exceeds custom threshold", async () => {
      mockInput.mockResolvedValue("yes");
      const result = await confirmLargeBatch(5, 3);
      expect(result).toBe(true);
      expect(mockInput).toHaveBeenCalled();
    });

    it("does not prompt when count is at custom threshold", async () => {
      const result = await confirmLargeBatch(3, 3);
      expect(result).toBe(true);
      expect(mockInput).not.toHaveBeenCalled();
    });
  });
});
