import { describe, it, expect } from "vitest";
import type { Task } from "../parser.js";
import { executorSkill } from "../skills/executor.js";

const TASK_FIXTURE: Task = {
  index: 0,
  text: "Implement the widget",
  line: 3,
  raw: "- [ ] Implement the widget",
  file: "/tmp/test/42-feature.md",
};

describe("executorSkill", () => {
  it("has name 'executor'", () => {
    expect(executorSkill.name).toBe("executor");
  });

  it("has buildPrompt and parseResult functions", () => {
    expect(typeof executorSkill.buildPrompt).toBe("function");
    expect(typeof executorSkill.parseResult).toBe("function");
  });
});

describe("buildPrompt", () => {
  it("builds a generic prompt when plan is null", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(prompt).toContain("Implement the widget");
    expect(prompt).toContain("/tmp/test");
    expect(prompt).toContain("/tmp/test/42-feature.md");
    expect(prompt).toContain("line 3");
    expect(prompt).not.toContain("Execution Plan");
  });

  it("builds a planned prompt when plan is provided", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
    });

    expect(prompt).toContain("Execution Plan");
    expect(prompt).toContain("Step 1: do X");
  });

  it("includes commit instruction when task text mentions commit", () => {
    const commitTask: Task = {
      ...TASK_FIXTURE,
      text: "Fix bug. Commit with message: fix: resolve bug",
    };

    const prompt = executorSkill.buildPrompt({
      task: commitTask,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(prompt).toContain("stage all changes and create a conventional commit");
  });

  it("excludes commit instruction when task text does not mention commit", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(prompt).toContain("Do NOT commit changes");
  });

  it("includes worktree isolation instructions when worktreeRoot is provided", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
      worktreeRoot: "/tmp/worktree",
    });

    expect(prompt).toContain("Worktree isolation");
    expect(prompt).toContain("/tmp/worktree");
    expect(prompt).toContain("MUST NOT read, write, or execute commands that access files outside");
  });

  it("excludes worktree isolation instructions when worktreeRoot is not provided", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(prompt).not.toContain("Worktree isolation");
  });

  it("includes worktree isolation in planned prompt when worktreeRoot is provided", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
      worktreeRoot: "/tmp/worktree",
    });

    expect(prompt).toContain("Execution Plan");
    expect(prompt).toContain("Step 1: do X");
    expect(prompt).toContain("Worktree isolation");
    expect(prompt).toContain("/tmp/worktree");
  });

  it("includes environment section in prompt (no plan)", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });

  it("includes environment section in planned prompt", () => {
    const prompt = executorSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: "Step 1: do X",
    });

    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });
});

describe("parseResult", () => {
  it("returns ExecutorData on valid response", () => {
    const result = executorSkill.parseResult("Task complete.", {
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      plan: null,
    });

    expect(result).toEqual({
      dispatchResult: { task: TASK_FIXTURE, success: true },
    });
  });

  it("throws when response is null", () => {
    expect(() =>
      executorSkill.parseResult(null, {
        task: TASK_FIXTURE,
        cwd: "/tmp/test",
        plan: null,
      }),
    ).toThrow("No response");
  });

  it("throws on 'You've hit your limit' rate-limit response", () => {
    expect(() =>
      executorSkill.parseResult("You've hit your limit \u00b7 resets 6pm (UTC)", {
        task: TASK_FIXTURE,
        cwd: "/tmp/test",
        plan: null,
      }),
    ).toThrow(/Rate limit/);
  });

  it("throws on 'rate limit exceeded' response", () => {
    expect(() =>
      executorSkill.parseResult("rate limit exceeded, please try again later", {
        task: TASK_FIXTURE,
        cwd: "/tmp/test",
        plan: null,
      }),
    ).toThrow(/Rate limit/);
  });

  it("throws on 'Too many requests' response", () => {
    expect(() =>
      executorSkill.parseResult("Too many requests", {
        task: TASK_FIXTURE,
        cwd: "/tmp/test",
        plan: null,
      }),
    ).toThrow(/Rate limit/);
  });

  it("throws on 'quota exceeded' response", () => {
    expect(() =>
      executorSkill.parseResult("Your quota exceeded for today", {
        task: TASK_FIXTURE,
        cwd: "/tmp/test",
        plan: null,
      }),
    ).toThrow(/Rate limit/);
  });

  it("does not throw on normal task output", async () => {
    const result = await executorSkill.parseResult(
      "Task complete. I've implemented the changes as requested.",
      { task: TASK_FIXTURE, cwd: "/tmp/test", plan: null },
    );

    expect(result.dispatchResult.success).toBe(true);
  });

  it("does not false-positive on 'limit' in normal task output", async () => {
    const result = await executorSkill.parseResult(
      "I've implemented the rate limiting feature as requested. Task complete.",
      { task: TASK_FIXTURE, cwd: "/tmp/test", plan: null },
    );

    expect(result.dispatchResult.success).toBe(true);
  });
});
