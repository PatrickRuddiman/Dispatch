import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTaskContent, parseTaskFile, markTaskComplete, buildTaskContext, groupTasksByMode, type Task } from "../parser.js";
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

// ─── parseTaskContent: mode extraction ───────────────────────────────

describe("parseTaskContent — mode extraction", () => {
  const FILE = "/fake/tasks.md";

  it("extracts (P) prefix as parallel mode and strips it from text", () => {
    const md = "- [ ] (P) Add validation to the user form";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "Add validation to the user form",
      mode: "parallel",
    });
  });

  it("extracts (S) prefix as serial mode and strips it from text", () => {
    const md = "- [ ] (S) Refactor the orchestrator dispatch loop";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "Refactor the orchestrator dispatch loop",
      mode: "serial",
    });
  });

  it("defaults to serial mode when no prefix is present", () => {
    const md = "- [ ] No prefix defaults to serial";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "No prefix defaults to serial",
      mode: "serial",
    });
  });

  it("preserves raw line with (P)/(S) prefix intact", () => {
    const md = "- [ ] (P) Parallel task";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0].raw).toBe("- [ ] (P) Parallel task");
  });

  it("handles mixed modes in the same file", () => {
    const md = [
      "- [ ] (P) First parallel task",
      "- [ ] (S) Serial task",
      "- [ ] Untagged task",
      "- [ ] (P) Second parallel task",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks[0]).toMatchObject({ text: "First parallel task", mode: "parallel" });
    expect(result.tasks[1]).toMatchObject({ text: "Serial task", mode: "serial" });
    expect(result.tasks[2]).toMatchObject({ text: "Untagged task", mode: "serial" });
    expect(result.tasks[3]).toMatchObject({ text: "Second parallel task", mode: "parallel" });
  });

  it("does not strip non-mode parenthetical prefixes", () => {
    const md = "- [ ] (parenthetical) notes should remain";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "(parenthetical) notes should remain",
      mode: "serial",
    });
  });

  it("does not match lowercase (p) or (s)", () => {
    const md = [
      "- [ ] (p) lowercase p",
      "- [ ] (s) lowercase s",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({ text: "(p) lowercase p", mode: "serial" });
    expect(result.tasks[1]).toMatchObject({ text: "(s) lowercase s", mode: "serial" });
  });

  it("handles (P)/(S) on indented tasks", () => {
    const md = [
      "  - [ ] (P) Indented parallel",
      "    - [ ] (S) Deeply indented serial",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({ text: "Indented parallel", mode: "parallel" });
    expect(result.tasks[1]).toMatchObject({ text: "Deeply indented serial", mode: "serial" });
  });

  it("handles (P)/(S) with CRLF line endings", () => {
    const md = "- [ ] (P) CRLF parallel task\r\n- [ ] (S) CRLF serial task\r\n";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({ text: "CRLF parallel task", mode: "parallel" });
    expect(result.tasks[1]).toMatchObject({ text: "CRLF serial task", mode: "serial" });
  });

  it("requires a space after (P)/(S) to count as a mode prefix", () => {
    const md = "- [ ] (P)NoSpace should not match";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "(P)NoSpace should not match",
      mode: "serial",
    });
  });

  it("handles multiple spaces after (P) prefix", () => {
    const md = "- [ ] (P)  Add feature with extra space";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "Add feature with extra space",
      mode: "parallel",
    });
  });

  it("handles special characters in task text after (P) prefix", () => {
    const md = [
      "- [ ] (P) Fix the `user?.name ?? 'default'` pattern",
      "- [ ] (S) Handle $PATH env variable",
      "- [ ] (P) Add `src/utils/*.ts` glob support",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0]).toMatchObject({
      text: "Fix the `user?.name ?? 'default'` pattern",
      mode: "parallel",
    });
    expect(result.tasks[1]).toMatchObject({
      text: "Handle $PATH env variable",
      mode: "serial",
    });
    expect(result.tasks[2]).toMatchObject({
      text: "Add `src/utils/*.ts` glob support",
      mode: "parallel",
    });
  });

  it("preserves parentheses in task text after mode prefix is stripped", () => {
    const md = "- [ ] (P) Refactor the (legacy) authentication module";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "Refactor the (legacy) authentication module",
      mode: "parallel",
    });
  });

  it("extracts mode from asterisk list markers", () => {
    const md = [
      "* [ ] (P) Parallel with asterisk",
      "* [ ] (S) Serial with asterisk",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({ text: "Parallel with asterisk", mode: "parallel" });
    expect(result.tasks[1]).toMatchObject({ text: "Serial with asterisk", mode: "serial" });
  });

  it("only strips the first mode prefix when multiple are present", () => {
    const md = "- [ ] (P) (S) ambiguous double prefix";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "(S) ambiguous double prefix",
      mode: "parallel",
    });
  });

  it("handles inline markdown formatting after mode prefix", () => {
    const md = [
      "- [ ] (P) Create **bold** feature",
      "- [ ] (S) Add [link](http://example.com) docs",
      "- [ ] (P) Use _italic_ emphasis here",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "Create **bold** feature",
      mode: "parallel",
    });
    expect(result.tasks[1]).toMatchObject({
      text: "Add [link](http://example.com) docs",
      mode: "serial",
    });
    expect(result.tasks[2]).toMatchObject({
      text: "Use _italic_ emphasis here",
      mode: "parallel",
    });
  });

  it("assigns serial mode to all untagged tasks in a mixed file", () => {
    const md = [
      "# Tasks",
      "",
      "- [ ] (P) Tagged parallel",
      "- [ ] First untagged",
      "- [ ] Second untagged",
      "- [ ] (S) Tagged serial",
      "- [ ] Third untagged",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(5);
    expect(result.tasks[0].mode).toBe("parallel");
    expect(result.tasks[1].mode).toBe("serial");
    expect(result.tasks[2].mode).toBe("serial");
    expect(result.tasks[3].mode).toBe("serial");
    expect(result.tasks[4].mode).toBe("serial");
  });

  it("handles tab character after mode prefix", () => {
    const md = "- [ ] (P)\tTab-separated task";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "Tab-separated task",
      mode: "parallel",
    });
  });

  it("does not extract mode when (P) or (S) appears mid-text", () => {
    const md = [
      "- [ ] Run the (P) optimization pass",
      "- [ ] Check the (S) synchronization flag",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "Run the (P) optimization pass",
      mode: "serial",
    });
    expect(result.tasks[1]).toMatchObject({
      text: "Check the (S) synchronization flag",
      mode: "serial",
    });
  });

  it("handles long task descriptions with special punctuation after prefix", () => {
    const md = "- [ ] (P) Refactor `src/agents/orchestrator.ts` — replace the flat dispatch loop with group-aware execution (see #5 for details)";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({
      text: "Refactor `src/agents/orchestrator.ts` — replace the flat dispatch loop with group-aware execution (see #5 for details)",
      mode: "parallel",
    });
  });

  it("extracts (I) prefix as isolated mode and strips it from text", () => {
    const md = "- [ ] (I) Run the full test suite after changes";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "Run the full test suite after changes",
      mode: "isolated",
    });
  });

  it("preserves raw line with (I) prefix intact", () => {
    const md = "- [ ] (I) Isolated task";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0].raw).toBe("- [ ] (I) Isolated task");
  });

  it("handles (I) on indented tasks", () => {
    const md = [
      "  - [ ] (I) Indented isolated task",
      "    - [ ] (I) Deeply indented isolated task",
    ].join("\n");

    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({ text: "Indented isolated task", mode: "isolated" });
    expect(result.tasks[1]).toMatchObject({ text: "Deeply indented isolated task", mode: "isolated" });
  });

  it("handles (I) with CRLF line endings", () => {
    const md = "- [ ] (I) CRLF isolated task\r\n- [ ] (P) CRLF parallel task\r\n";
    const result = parseTaskContent(md, FILE);
    expect(result.tasks[0]).toMatchObject({ text: "CRLF isolated task", mode: "isolated" });
    expect(result.tasks[1]).toMatchObject({ text: "CRLF parallel task", mode: "parallel" });
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

// ─── buildTaskContext ────────────────────────────────────────────────

describe("buildTaskContext", () => {
  const FILE = "/fake/tasks.md";

  it("keeps the current task and removes other unchecked tasks", () => {
    const md = [
      "# Setup",
      "",
      "- [ ] First task",
      "- [ ] Second task",
      "- [ ] Third task",
    ].join("\n");

    const task = { index: 1, text: "Second task", line: 4, raw: "- [ ] Second task", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toContain("# Setup");
    expect(result).toContain("- [ ] Second task");
    expect(result).not.toContain("First task");
    expect(result).not.toContain("Third task");
  });

  it("preserves all non-task content (headings, prose, blank lines)", () => {
    const md = [
      "# API Refactor",
      "",
      "We are migrating from Express to Hono.",
      "",
      "## Phase 1",
      "",
      "- [ ] Create app.ts",
      "- [ ] Add health check",
      "",
      "## Notes",
      "",
      "Use the new middleware pattern.",
    ].join("\n");

    const task = { index: 0, text: "Create app.ts", line: 7, raw: "- [ ] Create app.ts", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toContain("# API Refactor");
    expect(result).toContain("We are migrating from Express to Hono.");
    expect(result).toContain("## Phase 1");
    expect(result).toContain("## Notes");
    expect(result).toContain("Use the new middleware pattern.");
    expect(result).toContain("- [ ] Create app.ts");
    expect(result).not.toContain("Add health check");
  });

  it("preserves checked tasks (they are context, not work items)", () => {
    const md = [
      "- [x] Already done step",
      "- [ ] Current task",
      "- [ ] Other pending task",
    ].join("\n");

    const task = { index: 0, text: "Current task", line: 2, raw: "- [ ] Current task", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toContain("- [x] Already done step");
    expect(result).toContain("- [ ] Current task");
    expect(result).not.toContain("Other pending task");
  });

  it("works when the file has only one unchecked task", () => {
    const md = [
      "# Solo",
      "",
      "- [ ] The only task",
    ].join("\n");

    const task = { index: 0, text: "The only task", line: 3, raw: "- [ ] The only task", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toBe(md);
  });

  it("handles indented sibling tasks", () => {
    const md = [
      "- [ ] Parent task",
      "  - [ ] Child task A",
      "  - [ ] Child task B",
      "  - [ ] Child task C",
    ].join("\n");

    const task = { index: 1, text: "Child task A", line: 2, raw: "  - [ ] Child task A", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toContain("  - [ ] Child task A");
    expect(result).not.toContain("Parent task");
    expect(result).not.toContain("Child task B");
    expect(result).not.toContain("Child task C");
  });

  it("handles CRLF line endings", () => {
    const md = "# Title\r\n\r\n- [ ] Task A\r\n- [ ] Task B\r\n";

    const task = { index: 1, text: "Task B", line: 4, raw: "- [ ] Task B", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toContain("# Title");
    expect(result).toContain("- [ ] Task B");
    expect(result).not.toContain("Task A");
  });

  it("preserves asterisk tasks of other types in non-task content", () => {
    const md = [
      "* regular list item",
      "* [ ] Task one",
      "* [ ] Task two",
      "* another regular item",
    ].join("\n");

    const task = { index: 0, text: "Task one", line: 2, raw: "* [ ] Task one", file: FILE };
    const result = buildTaskContext(md, task);

    expect(result).toContain("* regular list item");
    expect(result).toContain("* [ ] Task one");
    expect(result).toContain("* another regular item");
    expect(result).not.toContain("Task two");
  });

  it("produces a realistic filtered context for a multi-section file", () => {
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

    // Planning for the JWT middleware task (line 16)
    const task = {
      index: 2,
      text: "Move JWT middleware to `src/middleware/auth.ts`",
      line: 16,
      raw: "- [ ] Move JWT middleware to `src/middleware/auth.ts`",
      file: FILE,
    };
    const result = buildTaskContext(md, task);

    // Should contain all headings and prose
    expect(result).toContain("# API Refactor");
    expect(result).toContain("We are migrating from Express to Hono.");
    expect(result).toContain("## Phase 1: Setup");
    expect(result).toContain("## Phase 2: Auth");
    expect(result).toContain("Auth uses JWT with RS256. The public key is at `config/jwt.pub`.");
    expect(result).toContain("## Phase 3: Cleanup");

    // Should contain the checked task (context)
    expect(result).toContain("- [x] Install hono");

    // Should contain ONLY the target task
    expect(result).toContain("- [ ] Move JWT middleware to `src/middleware/auth.ts`");

    // Should NOT contain any other unchecked tasks
    expect(result).not.toContain("Create `src/app.ts`");
    expect(result).not.toContain("Migrate health check");
    expect(result).not.toContain("Support both cookie");
    expect(result).not.toContain("Return 401");
    expect(result).not.toContain("Remove Express");
    expect(result).not.toContain("Update Dockerfile");
  });
});

// ─── groupTasksByMode ───────────────────────────────────────────────

describe("groupTasksByMode", () => {
  /** Helper to create a minimal Task with the given mode */
  function makeTask(mode?: "parallel" | "serial" | "isolated", index = 0): Task {
    return {
      index,
      text: `Task ${index}`,
      line: index + 1,
      raw: `- [ ] Task ${index}`,
      file: "/fake/tasks.md",
      mode,
    };
  }

  it("returns empty array for empty input", () => {
    expect(groupTasksByMode([])).toEqual([]);
  });

  it("groups a lone serial task as a solo group", () => {
    const tasks = [makeTask("serial", 0)];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
    expect(groups[0][0].mode).toBe("serial");
  });

  it("groups a lone parallel task as a solo group", () => {
    const tasks = [makeTask("parallel", 0)];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
    expect(groups[0][0].mode).toBe("parallel");
  });

  it("accumulates consecutive parallel tasks into one group", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("parallel", 1),
      makeTask("parallel", 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("serial task caps the current group", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("serial", 1),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    expect(groups[0][0].mode).toBe("parallel");
    expect(groups[0][1].mode).toBe("serial");
  });

  it("produces correct groups for P S S P P P pattern", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("serial", 1),
      makeTask("serial", 2),
      makeTask("parallel", 3),
      makeTask("parallel", 4),
      makeTask("parallel", 5),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(2); // [P, S]
    expect(groups[1]).toHaveLength(1); // [S]
    expect(groups[2]).toHaveLength(3); // [P, P, P]
  });

  it("handles all-serial tasks as individual solo groups", () => {
    const tasks = [
      makeTask("serial", 0),
      makeTask("serial", 1),
      makeTask("serial", 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
    expect(groups[2]).toHaveLength(1);
  });

  it("treats undefined mode as serial (default behavior)", () => {
    const tasks = [
      makeTask(undefined, 0),
      makeTask("parallel", 1),
      makeTask(undefined, 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1); // [undefined/serial]
    expect(groups[1]).toHaveLength(2); // [P, undefined/serial]
  });

  it("preserves task order within groups", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("parallel", 1),
      makeTask("serial", 2),
      makeTask("parallel", 3),
      makeTask("parallel", 4),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups[0].map((t) => t.index)).toEqual([0, 1, 2]);
    expect(groups[1].map((t) => t.index)).toEqual([3, 4]);
  });

  it("handles serial at start followed by parallel tasks", () => {
    const tasks = [
      makeTask("serial", 0),
      makeTask("parallel", 1),
      makeTask("parallel", 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1); // [S]
    expect(groups[1]).toHaveLength(2); // [P, P]
  });

  it("handles alternating P S P S pattern", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("serial", 1),
      makeTask("parallel", 2),
      makeTask("serial", 3),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2); // [P, S]
    expect(groups[1]).toHaveLength(2); // [P, S]
  });

  it("single serial task produces exactly one group of length 1", () => {
    const tasks = [makeTask("serial", 0)];
    const groups = groupTasksByMode(tasks);
    expect(groups).toEqual([[tasks[0]]]);
  });

  it("groups a lone isolated task as a solo group", () => {
    const tasks = [makeTask("isolated", 0)];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
    expect(groups[0][0].mode).toBe("isolated");
  });

  it("isolated task at start flushes into solo group before remaining tasks", () => {
    const tasks = [
      makeTask("isolated", 0),
      makeTask("parallel", 1),
      makeTask("parallel", 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1); // [I]
    expect(groups[0][0].mode).toBe("isolated");
    expect(groups[1]).toHaveLength(2); // [P, P]
  });

  it("isolated task in middle produces three groups (P P I P P)", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("parallel", 1),
      makeTask("isolated", 2),
      makeTask("parallel", 3),
      makeTask("parallel", 4),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(2); // [P, P]
    expect(groups[1]).toHaveLength(1); // [I]
    expect(groups[1][0].mode).toBe("isolated");
    expect(groups[2]).toHaveLength(2); // [P, P]
  });

  it("isolated task at end flushes preceding group first", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("parallel", 1),
      makeTask("isolated", 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2); // [P, P]
    expect(groups[1]).toHaveLength(1); // [I]
    expect(groups[1][0].mode).toBe("isolated");
  });

  it("consecutive isolated tasks each get their own solo group", () => {
    const tasks = [
      makeTask("isolated", 0),
      makeTask("isolated", 1),
      makeTask("isolated", 2),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
    expect(groups[2]).toHaveLength(1);
    expect(groups[0][0].mode).toBe("isolated");
    expect(groups[1][0].mode).toBe("isolated");
    expect(groups[2][0].mode).toBe("isolated");
  });

  it("handles mixed P/S/I sequences", () => {
    const tasks = [
      makeTask("parallel", 0),
      makeTask("serial", 1),
      makeTask("isolated", 2),
      makeTask("parallel", 3),
      makeTask("parallel", 4),
      makeTask("isolated", 5),
      makeTask("serial", 6),
    ];
    const groups = groupTasksByMode(tasks);
    expect(groups).toHaveLength(5);
    expect(groups[0]).toHaveLength(2); // [P, S]
    expect(groups[1]).toHaveLength(1); // [I]
    expect(groups[1][0].mode).toBe("isolated");
    expect(groups[2]).toHaveLength(2); // [P, P]
    expect(groups[3]).toHaveLength(1); // [I]
    expect(groups[3][0].mode).toBe("isolated");
    expect(groups[4]).toHaveLength(1); // [S]
  });
});
