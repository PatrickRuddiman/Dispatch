import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTaskContent, parseTaskFile, markTaskComplete } from "./parser.js";
import { readFile } from "node:fs/promises";

// ─── parseTaskContent (pure, no I/O) ─────────────────────────────────

describe("parseTaskContent", () => {
  const FILE = "/fake/tasks.md";

  it("extracts basic dash tasks", () => {
    const md = [
      "- [ ] First task",
      "- [ ] Second task",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      index: 0,
      text: "First task",
      line: 1,
      raw: "- [ ] First task",
      file: FILE,
    });
    expect(result.tasks[1]).toMatchObject({
      index: 1,
      text: "Second task",
      line: 2,
    });
  });

  it("extracts asterisk tasks", () => {
    const md = [
      "* [ ] Asterisk task one",
      "* [ ] Asterisk task two",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].text).toBe("Asterisk task one");
    expect(result.tasks[1].text).toBe("Asterisk task two");
  });

  it("handles indented tasks (nested lists)", () => {
    const md = [
      "- [ ] Top-level task",
      "  - [ ] Indented 2 spaces",
      "    - [ ] Indented 4 spaces",
      "      - [ ] Indented 6 spaces",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks[0].text).toBe("Top-level task");
    expect(result.tasks[1].text).toBe("Indented 2 spaces");
    expect(result.tasks[2].text).toBe("Indented 4 spaces");
    expect(result.tasks[3].text).toBe("Indented 6 spaces");
  });

  it("handles tab-indented tasks", () => {
    const md = [
      "- [ ] Top-level",
      "\t- [ ] Tab indented",
      "\t\t- [ ] Double tab indented",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[1].text).toBe("Tab indented");
    expect(result.tasks[2].text).toBe("Double tab indented");
  });

  it("skips already-checked tasks", () => {
    const md = [
      "- [x] Already done",
      "- [ ] Still pending",
      "- [X] Also done (uppercase)",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].text).toBe("Still pending");
  });

  it("handles mixed task and non-task content", () => {
    const md = [
      "# Project Setup",
      "",
      "Use TypeScript with strict mode enabled.",
      "",
      "## Tasks",
      "",
      "- [ ] Create the config file",
      "- [x] Install dependencies",
      "",
      "Some notes about implementation details.",
      "",
      "- [ ] Write unit tests",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ text: "Create the config file", line: 7 });
    expect(result.tasks[1]).toMatchObject({ text: "Write unit tests", line: 12 });
  });

  it("preserves full file content in the content field", () => {
    const md = [
      "# Notes",
      "",
      "Important: use the `zod` library for validation.",
      "",
      "- [ ] Add schema validation",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.content).toBe(md);
  });

  it("returns correct line numbers with blank lines", () => {
    const md = [
      "",
      "",
      "- [ ] Task after blank lines",
      "",
      "- [ ] Another task",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0].line).toBe(3);
    expect(result.tasks[1].line).toBe(5);
  });

  it("returns empty tasks for a file with no checkboxes", () => {
    const md = [
      "# Just a heading",
      "",
      "Some prose with no tasks.",
      "- regular list item",
      "* another regular item",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(0);
  });

  it("returns empty tasks for an empty file", () => {
    const result = parseTaskContent("", FILE);
    expect(result.tasks).toHaveLength(0);
    expect(result.content).toBe("");
  });

  it("handles tasks with inline markdown formatting", () => {
    const md = [
      "- [ ] Create `src/utils/hello.ts` with a **greet** function",
      "- [ ] Add [link](http://example.com) to the docs",
      "- [ ] Use _italic_ emphasis here",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0].text).toBe("Create `src/utils/hello.ts` with a **greet** function");
    expect(result.tasks[1].text).toBe("Add [link](http://example.com) to the docs");
    expect(result.tasks[2].text).toBe("Use _italic_ emphasis here");
  });

  it("handles tasks with special characters", () => {
    const md = [
      "- [ ] Fix the `user?.name ?? 'default'` pattern",
      "- [ ] Handle $PATH env variable",
      "- [ ] Support (parenthetical) notes",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0].text).toBe("Fix the `user?.name ?? 'default'` pattern");
  });

  it("does not match lines without proper checkbox syntax", () => {
    const md = [
      "- [] Missing space in checkbox",
      "-[ ] Missing space after dash",
      "- [  ] Extra space in checkbox",
      "[ ] No list marker",
      "  [ ] Indented but no list marker",
      "- [ ]No space after checkbox",
      "- [ ] Valid task",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].text).toBe("Valid task");
  });

  it("assigns sequential zero-based indices", () => {
    const md = [
      "# Header",
      "- [ ] First",
      "Some text",
      "- [ ] Second",
      "More text",
      "- [ ] Third",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("preserves the raw line including indentation", () => {
    const md = "    - [ ] Deeply indented task";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0].raw).toBe("    - [ ] Deeply indented task");
  });

  it("handles a realistic multi-section task file", () => {
    const md = [
      "# API Refactor",
      "",
      "We are migrating from Express to Hono. All routes should use",
      "the new `Hono` router and middleware pattern.",
      "",
      "## Phase 1: Setup",
      "",
      "- [x] Install hono",
      "- [ ] Create `src/app.ts` entry point with Hono instance",
      "- [ ] Migrate health check route to `/health`",
      "",
      "## Phase 2: Auth",
      "",
      "Auth uses JWT with RS256. The public key is at `config/jwt.pub`.",
      "",
      "- [ ] Move JWT middleware to `src/middleware/auth.ts`",
      "  - [ ] Support both cookie and Authorization header",
      "  - [ ] Return 401 with `{ error: 'unauthorized' }` body",
      "",
      "## Phase 3: Cleanup",
      "",
      "- [ ] Remove Express dependency from package.json",
      "- [ ] Update Dockerfile CMD to use new entry point",
    ].join("\n");

    const result = parseTaskContent(md, FILE);

    // Should find all 7 unchecked tasks, skip the 1 checked task
    expect(result.tasks).toHaveLength(7);

    expect(result.tasks[0].text).toBe("Create `src/app.ts` entry point with Hono instance");
    expect(result.tasks[0].line).toBe(9);

    expect(result.tasks[1].text).toBe("Migrate health check route to `/health`");
    expect(result.tasks[1].line).toBe(10);

    expect(result.tasks[2].text).toBe("Move JWT middleware to `src/middleware/auth.ts`");
    expect(result.tasks[2].line).toBe(16);

    // Indented sub-tasks
    expect(result.tasks[3].text).toBe("Support both cookie and Authorization header");
    expect(result.tasks[3].line).toBe(17);

    expect(result.tasks[4].text).toBe("Return 401 with `{ error: 'unauthorized' }` body");
    expect(result.tasks[4].line).toBe(18);

    expect(result.tasks[5].text).toBe("Remove Express dependency from package.json");
    expect(result.tasks[5].line).toBe(22);

    expect(result.tasks[6].text).toBe("Update Dockerfile CMD to use new entry point");
    expect(result.tasks[6].line).toBe(23);

    // Full content preserved
    expect(result.content).toBe(md);
  });

  it("handles single-task file", () => {
    const md = "- [ ] The only task";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].text).toBe("The only task");
  });

  it("handles trailing newline", () => {
    const md = "- [ ] Task one\n- [ ] Task two\n";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(2);
  });

  it("handles Windows-style CRLF line endings", () => {
    const md = "- [ ] Task one\r\n- [ ] Task two\r\n";
    // split("\n") will leave \r at end of lines; the regex matches .+ which includes \r
    // but .trim() on the text should handle it
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(2);
    // Text should be trimmed cleanly
    expect(result.tasks[0].text).toBe("Task one");
    expect(result.tasks[1].text).toBe("Task two");
  });
});

// ─── parseTaskFile (with file I/O) ───────────────────────────────────

describe("parseTaskFile", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads and parses a file from disk", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "tasks.md");
    const md = [
      "# Tasks",
      "- [ ] Task from file",
      "- [x] Done task",
      "- [ ] Another pending task",
    ].join("\n");
    await writeFile(filePath, md, "utf-8");

    const result = await parseTaskFile(filePath);
    expect(result.path).toBe(filePath);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].text).toBe("Task from file");
    expect(result.tasks[0].file).toBe(filePath);
    expect(result.tasks[1].text).toBe("Another pending task");
    expect(result.content).toBe(md);
  });
});

// ─── markTaskComplete ────────────────────────────────────────────────

describe("markTaskComplete", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("replaces [ ] with [x] at the correct line", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "tasks.md");
    const md = [
      "# Tasks",
      "- [ ] First task",
      "- [ ] Second task",
    ].join("\n");
    await writeFile(filePath, md, "utf-8");

    const task = {
      index: 0,
      text: "First task",
      line: 2,
      raw: "- [ ] First task",
      file: filePath,
    };

    await markTaskComplete(task);

    const updated = await readFile(filePath, "utf-8");
    const lines = updated.split("\n");
    expect(lines[1]).toBe("- [x] First task");
    // Second task should remain unchecked
    expect(lines[2]).toBe("- [ ] Second task");
  });

  it("preserves indentation when marking complete", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "tasks.md");
    const md = "    - [ ] Indented task";
    await writeFile(filePath, md, "utf-8");

    const task = {
      index: 0,
      text: "Indented task",
      line: 1,
      raw: "    - [ ] Indented task",
      file: filePath,
    };

    await markTaskComplete(task);

    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("    - [x] Indented task");
  });

  it("throws on out-of-range line number", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "tasks.md");
    await writeFile(filePath, "- [ ] Only task", "utf-8");

    const task = {
      index: 0,
      text: "Phantom",
      line: 99,
      raw: "- [ ] Phantom",
      file: filePath,
    };

    await expect(markTaskComplete(task)).rejects.toThrow("out of range");
  });

  it("throws if the line no longer matches unchecked pattern", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    const filePath = join(tmpDir, "tasks.md");
    await writeFile(filePath, "- [x] Already done", "utf-8");

    const task = {
      index: 0,
      text: "Already done",
      line: 1,
      raw: "- [x] Already done",
      file: filePath,
    };

    await expect(markTaskComplete(task)).rejects.toThrow("does not match");
  });
});
