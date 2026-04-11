/**
 * System prompt loader for the orchestrator shell.
 *
 * Reads the Dispatch skill file (skills/dispatch/SKILL.md) and uses it
 * as the system prompt. Appends a wait-for-input instruction and optional
 * resume context when restarting after a crash.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ResumeContext {
  runs: Array<{
    runId: string;
    issueIds: string[];
    status: string;
  }>;
}

/** Path to the skill file relative to the package root. */
const SKILL_PATH = "skills/dispatch/SKILL.md";

/**
 * Resolve the skill file path. Tries the cwd first (for dev), then
 * walks up to find the package root containing the skills directory.
 */
async function resolveSkillPath(cwd: string): Promise<string> {
  // Try cwd directly
  const direct = join(cwd, SKILL_PATH);
  try {
    await readFile(direct, "utf-8");
    return direct;
  } catch { /* not found */ }

  // Try relative to this file's package (installed location)
  // import.meta.dirname is dist/ when bundled, so .. reaches package root
  const packageRoot = join(import.meta.dirname, "..");
  const installed = join(packageRoot, SKILL_PATH);
  try {
    await readFile(installed, "utf-8");
    return installed;
  } catch { /* not found */ }

  // Fallback: return cwd path (will fail with a clear error)
  return direct;
}

/**
 * Load the system prompt from the Dispatch skill file.
 */
export async function loadSystemPrompt(cwd: string, resumeContext?: ResumeContext): Promise<string> {
  const skillPath = await resolveSkillPath(cwd);

  let skillContent: string;
  try {
    skillContent = await readFile(skillPath, "utf-8");
    // Strip YAML frontmatter if present
    if (skillContent.startsWith("---")) {
      const endIdx = skillContent.indexOf("---", 3);
      if (endIdx !== -1) {
        skillContent = skillContent.slice(endIdx + 3).trim();
      }
    }
  } catch {
    // Fallback if skill file is missing
    skillContent = "You are an autonomous coding orchestrator powered by Dispatch. Use the Dispatch MCP tools to manage coding tasks.";
  }

  const sections: string[] = [skillContent];

  sections.push(`\n\n## Important

Wait for the user to give you instructions before taking any action. Do not start dispatching or speccing issues on your own.`);

  if (resumeContext && resumeContext.runs.length > 0) {
    const runLines = resumeContext.runs.map((r) => {
      const issues = r.issueIds.join(", ");
      return `- Run ${r.runId.slice(0, 8)}: status=${r.status}, issues=[${issues}]`;
    });

    sections.push(`\n\n## Resume Context

You are resuming after a session restart. The following runs were in progress:

${runLines.join("\n")}

Use the monitor tools to check the current status of each run and continue where you left off.
Runs dispatched through the MCP server continue executing even when the orchestrator restarts.`);
  }

  return sections.join("");
}
