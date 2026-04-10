import { describe, it, expect } from "vitest";
import type { Skill, SkillName } from "../skills/interface.js";
import {
  SKILL_NAMES,
  plannerSkill,
  executorSkill,
  specSkill,
  commitSkill,
} from "../skills/index.js";

// ─── Tests ──────────────────────────────────────────────────────────

describe("SKILL_NAMES", () => {
  it("contains all registered skill names", () => {
    expect(SKILL_NAMES).toContain("planner");
    expect(SKILL_NAMES).toContain("executor");
    expect(SKILL_NAMES).toContain("spec");
    expect(SKILL_NAMES).toContain("commit");
    expect(SKILL_NAMES).toHaveLength(4);
  });

  it("is an array of strings", () => {
    for (const name of SKILL_NAMES) {
      expect(typeof name).toBe("string");
    }
  });
});

describe("exported skill constants", () => {
  const skills: Array<{ skill: Skill<any, any>; expectedName: SkillName }> = [
    { skill: plannerSkill, expectedName: "planner" },
    { skill: executorSkill, expectedName: "executor" },
    { skill: specSkill, expectedName: "spec" },
    { skill: commitSkill, expectedName: "commit" },
  ];

  for (const { skill, expectedName } of skills) {
    it(`${expectedName}Skill has the correct name`, () => {
      expect(skill.name).toBe(expectedName);
    });

    it(`${expectedName}Skill has a buildPrompt function`, () => {
      expect(typeof skill.buildPrompt).toBe("function");
    });

    it(`${expectedName}Skill has a parseResult function`, () => {
      expect(typeof skill.parseResult).toBe("function");
    });
  }
});
