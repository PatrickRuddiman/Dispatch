import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock setup ────────────────────────────────────────────────────────────────

const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

vi.mock("../helpers/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    task: vi.fn(),
    verbose: false,
    formatErrorChain: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
    extractMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  },
}));

import { log } from "../helpers/logger.js";
import { ensureGitignoreEntry } from "../helpers/gitignore.js";

beforeEach(() => {
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── ensureGitignoreEntry ──────────────────────────────────────────────

describe("ensureGitignoreEntry", () => {
  it("no-ops when entry already exists in LF file", async () => {
    mockReadFile.mockResolvedValueOnce("node_modules\n.dispatch/worktrees/\n");

    await ensureGitignoreEntry("/repo", ".dispatch/worktrees/");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("no-ops when entry already exists in CRLF file", async () => {
    mockReadFile.mockResolvedValueOnce("node_modules\r\n.dispatch/worktrees/\r\n");

    await ensureGitignoreEntry("/repo", ".dispatch/worktrees/");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("no-ops when bare form (without trailing slash) already exists", async () => {
    mockReadFile.mockResolvedValueOnce("node_modules\n.dispatch/worktrees\n");

    await ensureGitignoreEntry("/repo", ".dispatch/worktrees/");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("creates .gitignore when file does not exist", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
    mockWriteFile.mockResolvedValueOnce(undefined);

    await ensureGitignoreEntry("/repo", ".dispatch/worktrees/");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/repo/.gitignore",
      ".dispatch/worktrees/\n",
      "utf8",
    );
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining(".dispatch/worktrees/"));
  });

  it("appends with newline separator when file lacks trailing newline", async () => {
    mockReadFile.mockResolvedValueOnce("node_modules");
    mockWriteFile.mockResolvedValueOnce(undefined);

    await ensureGitignoreEntry("/repo", ".dispatch/worktrees/");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/repo/.gitignore",
      "node_modules\n.dispatch/worktrees/\n",
      "utf8",
    );
  });

  it("logs warning and does not throw when writeFile fails", async () => {
    mockReadFile.mockResolvedValueOnce("");
    mockWriteFile.mockRejectedValueOnce(new Error("EACCES"));

    await expect(ensureGitignoreEntry("/repo", ".dispatch/worktrees/")).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });
});
