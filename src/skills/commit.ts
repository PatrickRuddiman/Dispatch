/**
 * Commit skill — analyzes branch changes and generates meaningful
 * conventional-commit-compliant commit messages, PR titles, and PR
 * descriptions.
 *
 * Stateless data object: defines prompt construction and result parsing
 * without coupling to any provider. The dispatcher handles execution.
 */

import type { Skill } from "./interface.js";
import type { IssueDetails } from "../datasources/interface.js";
import type { DispatchResult } from "../dispatcher.js";
import { formatEnvironmentPrompt } from "../helpers/environment.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/** Runtime input for the commit skill. */
export interface CommitInput {
  /** Git diff of the branch relative to the default branch */
  branchDiff: string;
  /** Issue details for context */
  issue: IssueDetails;
  /** Task dispatch results */
  taskResults: DispatchResult[];
  /** Working directory */
  cwd: string;
  /** Worktree root directory for isolation, if operating in a worktree */
  worktreeRoot?: string;
}

/** @deprecated Alias for CommitInput — kept for backward compatibility. */
export type CommitGenerateOptions = CommitInput;

/** Structured output from the commit skill. */
export interface CommitOutput {
  /** The generated conventional commit message */
  commitMessage: string;
  /** The generated PR title */
  prTitle: string;
  /** The generated PR description */
  prDescription: string;
}

// ---------------------------------------------------------------------------
// Stateless skill definition
// ---------------------------------------------------------------------------

/** The commit skill — stateless, no provider coupling. */
export const commitSkill: Skill<CommitInput, CommitOutput> = {
  name: "commit",

  buildPrompt(input: CommitInput): string {
    return buildCommitPrompt(input);
  },

  parseResult(response: string | null): CommitOutput {
    if (!response?.trim()) {
      throw new Error("Commit skill returned empty response");
    }

    const parsed = parseCommitResponse(response);

    if (!parsed.commitMessage || !parsed.prTitle) {
      throw new Error("Failed to parse commit response: no commit message or PR title found");
    }

    return parsed;
  },
};

// ---------------------------------------------------------------------------
// Prompt builder (exported — tests use it directly)
// ---------------------------------------------------------------------------

/**
 * Build the prompt that instructs the AI to analyze the branch diff and
 * generate a conventional commit message, PR title, and PR description.
 */
export function buildCommitPrompt(opts: CommitInput): string {
  const { branchDiff, issue, taskResults } = opts;

  const sections: string[] = [
    `Analyze the git diff below and generate a meaningful, conventional-commit-compliant commit message, a PR title, and a PR description.`,
    ``,
    formatEnvironmentPrompt(),
    ``,
    `## Conventional Commit Guidelines`,
    ``,
    `Follow the Conventional Commits specification (https://www.conventionalcommits.org/):`,
    `- Format: \`<type>(<optional scope>): <description>\``,
    `- Types: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`, \`style\`, \`perf\`, \`ci\``,
    `- The description should be concise, imperative mood, lowercase first letter, no period at the end`,
    `- If the change includes breaking changes, add \`!\` after the type/scope (e.g., \`feat!: ...\`)`,
    ``,
    `## Issue Context`,
    ``,
    `- **Issue #${issue.number}:** ${issue.title}`,
  ];

  if (issue.body) {
    sections.push(
      `- **Description:** ${issue.body.slice(0, 500)}${issue.body.length > 500 ? "..." : ""}`
    );
  }

  if (issue.labels.length > 0) {
    sections.push(`- **Labels:** ${issue.labels.join(", ")}`);
  }

  const completed = taskResults.filter((r) => r.success);
  const failed = taskResults.filter((r) => !r.success);

  if (taskResults.length > 0) {
    sections.push(``, `## Tasks`);
    if (completed.length > 0) {
      sections.push(``, `### Completed`);
      for (const r of completed) {
        sections.push(`- ${r.task.text}`);
      }
    }
    if (failed.length > 0) {
      sections.push(``, `### Failed`);
      for (const r of failed) {
        sections.push(
          `- ${r.task.text}${r.error ? ` (error: ${r.error})` : ""}`
        );
      }
    }
  }

  const maxDiffLength = 50_000;
  const truncatedDiff =
    branchDiff.length > maxDiffLength
      ? branchDiff.slice(0, maxDiffLength) +
        "\n\n... (diff truncated due to size)"
      : branchDiff;

  sections.push(
    ``,
    `## Git Diff`,
    ``,
    `\`\`\`diff`,
    truncatedDiff,
    `\`\`\``,
    ``,
    `## Required Output Format`,
    ``,
    `You MUST respond with exactly the following three sections, using these exact headers:`,
    ``,
    `### COMMIT_MESSAGE`,
    `<your conventional commit message here>`,
    ``,
    `### PR_TITLE`,
    `<your PR title here>`,
    ``,
    `### PR_DESCRIPTION`,
    `<your PR description in markdown here>`,
    ``,
    `**Rules:**`,
    `- The commit message MUST follow conventional commit format`,
    `- The PR title should be a concise, descriptive summary of the overall change`,
    `- The PR description should explain what changed and why, referencing the issue context`,
    `- Do NOT include any text outside these three sections`
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Response parser (exported — tests use it directly)
// ---------------------------------------------------------------------------

/**
 * Parse the structured response into commit message, PR title,
 * and PR description. Uses robust matching to handle minor formatting
 * variations.
 */
export function parseCommitResponse(response: string): {
  commitMessage: string;
  prTitle: string;
  prDescription: string;
} {
  const result = {
    commitMessage: "",
    prTitle: "",
    prDescription: "",
  };

  const commitMatch = response.match(
    /###\s*COMMIT_MESSAGE\s*\n([\s\S]*?)(?=###\s*PR_TITLE|$)/i
  );
  const titleMatch = response.match(
    /###\s*PR_TITLE\s*\n([\s\S]*?)(?=###\s*PR_DESCRIPTION|$)/i
  );
  const descMatch = response.match(
    /###\s*PR_DESCRIPTION\s*\n([\s\S]*?)$/i
  );

  if (commitMatch?.[1]) {
    result.commitMessage = commitMatch[1].trim();
  }
  if (titleMatch?.[1]) {
    result.prTitle = titleMatch[1].trim();
  }
  if (descMatch?.[1]) {
    result.prDescription = descMatch[1].trim();
  }

  return result;
}
