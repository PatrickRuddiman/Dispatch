import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  openDatabase,
  closeDatabase,
  resetDatabase,
  getDb,
  RUN_STATUSES,
  TASK_STATUSES,
  SPEC_STATUSES,
} from "../mcp/state/database.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

// ─── Helpers ──────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `dispatch-db-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Setup / teardown ─────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  resetDatabase();
  tempDir = makeTempDir();
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─── Constants ────────────────────────────────────────────────

describe("status constants", () => {
  it("RUN_STATUSES contains expected values", () => {
    expect(RUN_STATUSES).toContain("running");
    expect(RUN_STATUSES).toContain("completed");
    expect(RUN_STATUSES).toContain("failed");
    expect(RUN_STATUSES).toContain("cancelled");
  });

  it("TASK_STATUSES contains expected values", () => {
    expect(TASK_STATUSES).toContain("pending");
    expect(TASK_STATUSES).toContain("running");
    expect(TASK_STATUSES).toContain("success");
    expect(TASK_STATUSES).toContain("failed");
    expect(TASK_STATUSES).toContain("skipped");
  });

  it("SPEC_STATUSES contains expected values", () => {
    expect(SPEC_STATUSES).toContain("running");
    expect(SPEC_STATUSES).toContain("completed");
    expect(SPEC_STATUSES).toContain("failed");
  });
});

// ─── openDatabase ─────────────────────────────────────────────

describe("openDatabase", () => {
  it("creates .dispatch directory and returns a Database instance", () => {
    const db = openDatabase(tempDir);
    expect(db).toBeDefined();
    expect(typeof db.exec).toBe("function");
  });

  it("returns the same singleton on second call", () => {
    const db1 = openDatabase(tempDir);
    const db2 = openDatabase(tempDir);
    expect(db1).toBe(db2);
  });

  it("creates schema tables", () => {
    const db = openDatabase(tempDir);
    // Verify schema_version table exists and has a row
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.version).toBe(1);
  });

  it("creates runs table", () => {
    const db = openDatabase(tempDir);
    expect(() => db.prepare("SELECT * FROM runs LIMIT 1").all()).not.toThrow();
  });

  it("creates tasks table", () => {
    const db = openDatabase(tempDir);
    expect(() => db.prepare("SELECT * FROM tasks LIMIT 1").all()).not.toThrow();
  });

  it("creates spec_runs table", () => {
    const db = openDatabase(tempDir);
    expect(() => db.prepare("SELECT * FROM spec_runs LIMIT 1").all()).not.toThrow();
  });
});

// ─── getDb ────────────────────────────────────────────────────

describe("getDb", () => {
  it("throws when database has not been opened", () => {
    // resetDatabase called in beforeEach, so _db is null
    expect(() => getDb()).toThrow("Database not open");
  });

  it("returns the open database after openDatabase is called", () => {
    const db = openDatabase(tempDir);
    expect(getDb()).toBe(db);
  });
});

// ─── closeDatabase ────────────────────────────────────────────

describe("closeDatabase", () => {
  it("closes the database and resets singleton", () => {
    openDatabase(tempDir);
    closeDatabase();
    // getDb should throw now
    expect(() => getDb()).toThrow("Database not open");
  });

  it("is safe to call when no database is open", () => {
    expect(() => closeDatabase()).not.toThrow();
  });
});

// ─── resetDatabase ────────────────────────────────────────────

describe("resetDatabase", () => {
  it("clears the singleton without closing the database connection", () => {
    openDatabase(tempDir);
    resetDatabase();
    // getDb should throw after reset
    expect(() => getDb()).toThrow("Database not open");
  });
});

// ─── Schema persistence ───────────────────────────────────────

describe("schema persistence", () => {
  it("can insert and retrieve a run row", () => {
    const db = openDatabase(tempDir);
    db.prepare(`
      INSERT INTO runs (run_id, cwd, issue_ids, status, started_at)
      VALUES ('run-1', '/tmp', '["1"]', 'running', ?)
    `).run(Date.now());

    const row = db.prepare("SELECT * FROM runs WHERE run_id = 'run-1'").get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.["run_id"]).toBe("run-1");
    expect(row?.["status"]).toBe("running");
  });
});
