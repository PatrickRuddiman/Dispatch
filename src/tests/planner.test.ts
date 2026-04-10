import { describe, it, expect } from "vitest";
import { plannerSkill } from "../skills/planner.js";
import { createMockTask } from "./fixtures.js";

const TASK_FIXTURE = createMockTask();

describe("plannerSkill", () => {
  it("has name 'planner'", () => {
    expect(plannerSkill.name).toBe("planner");
  });

  it("has buildPrompt and parseResult functions", () => {
    expect(typeof plannerSkill.buildPrompt).toBe("function");
    expect(typeof plannerSkill.parseResult).toBe("function");
  });
});

describe("buildPrompt", () => {
  it("includes task metadata in the prompt", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/workspace",
    });

    expect(prompt).toContain("/workspace");
    expect(prompt).toContain(TASK_FIXTURE.file);
    expect(prompt).toContain(`line ${TASK_FIXTURE.line}`);
    expect(prompt).toContain(TASK_FIXTURE.text);
  });

  it("includes file context in the prompt when provided", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      fileContext: "# Heading\nSome context about the task",
    });

    expect(prompt).toContain("Task File Contents");
    expect(prompt).toContain("# Heading\nSome context about the task");
  });

  it("does not include file context section when fileContext is not provided", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
    });

    expect(prompt).not.toContain("Task File Contents");
  });

  it("includes worktree isolation instructions when worktreeRoot is provided", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/worktree/path",
      worktreeRoot: "/worktree/path",
    });

    expect(prompt).toContain("Worktree Isolation");
    expect(prompt).toContain("/worktree/path");
    expect(prompt).toContain("MUST be confined");
  });

  it("does not include worktree isolation instructions when worktreeRoot is not provided", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
    });

    expect(prompt).not.toContain("Worktree Isolation");
  });

  it("includes all worktree restriction instructions in the prompt", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      worktreeRoot: "/wt/issue-1",
    });

    expect(prompt).toContain("Do NOT read, write, or execute commands that access files outside this directory.");
    expect(prompt).toContain("Do NOT reference or modify files in the main repository working tree or other worktrees.");
    expect(prompt).toContain("All relative paths must resolve within the worktree root above.");
  });

  it("includes both file context and worktree isolation when both are provided", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      fileContext: "# Design\nSome notes",
      worktreeRoot: "/wt/issue-1",
    });

    expect(prompt).toContain("Task File Contents");
    expect(prompt).toContain("# Design\nSome notes");
    expect(prompt).toContain("Worktree Isolation");
    expect(prompt).toContain("/wt/issue-1");
  });

  it("places worktreeRoot in isolation section and cwd in task section independently", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/workspace/repo",
      worktreeRoot: "/workspace/repo/.dispatch/worktrees/slug",
    });

    expect(prompt).toContain("**Working directory:** /workspace/repo");
    expect(prompt).toContain("/workspace/repo/.dispatch/worktrees/slug");
    expect(prompt).toContain("Worktree Isolation");
  });

  it("does not include worktree isolation when worktreeRoot is empty string", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
      worktreeRoot: "",
    });

    expect(prompt).not.toContain("Worktree Isolation");
  });

  it("includes environment section in the prompt", () => {
    const prompt = plannerSkill.buildPrompt({
      task: TASK_FIXTURE,
      cwd: "/tmp/test",
    });

    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Operating System");
    expect(prompt).toContain("Do NOT write intermediate scripts");
  });
});

describe("parseResult", () => {
  it("returns PlannerData with prompt on non-empty response", () => {
    const result = plannerSkill.parseResult("Step 1: do X", {
      task: TASK_FIXTURE,
      cwd: "/tmp",
    });

    expect(result).toEqual({ prompt: "Step 1: do X" });
  });

  it("throws when response is empty string", () => {
    expect(() =>
      plannerSkill.parseResult("", { task: TASK_FIXTURE, cwd: "/tmp" }),
    ).toThrow("Planner returned empty plan");
  });

  it("throws when response is whitespace-only", () => {
    expect(() =>
      plannerSkill.parseResult("   \n  \t  ", { task: TASK_FIXTURE, cwd: "/tmp" }),
    ).toThrow("Planner returned empty plan");
  });

  it("throws when response is null", () => {
    expect(() =>
      plannerSkill.parseResult(null, { task: TASK_FIXTURE, cwd: "/tmp" }),
    ).toThrow("Planner returned empty plan");
  });
});
