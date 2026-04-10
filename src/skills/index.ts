/**
 * Skill registry — exports all skill definitions and their types.
 *
 * Skills are stateless data objects. The dispatcher handles execution.
 */

import { plannerSkill } from "./planner.js";
import { executorSkill } from "./executor.js";
import { specSkill } from "./spec.js";
import { commitSkill } from "./commit.js";

export type { Skill, SkillName } from "./interface.js";
export type { SkillResult, SkillErrorCode, PlannerData, ExecutorData, SpecData } from "./types.js";
export type { PlannerInput } from "./planner.js";
export type { ExecutorInput, ExecuteInput } from "./executor.js";
export type { SpecInput } from "./spec.js";
export type { CommitInput, CommitOutput, CommitGenerateOptions } from "./commit.js";

export { plannerSkill, executorSkill, specSkill, commitSkill };

/** All skill names — useful for CLI help text and validation. */
export const SKILL_NAMES = ["planner", "executor", "spec", "commit"] as const;
