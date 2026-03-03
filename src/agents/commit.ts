/**
 * Commit agent — analyzes branch changes and generates meaningful
 * conventional-commit-compliant commit messages, PR titles, and PR
 * descriptions using an AI provider.
 *
 * The commit agent runs after all tasks complete but before the PR is
 * created. It receives the branch diff, issue context, and task results,
 * prompts the AI provider, parses the structured response, and writes
 * the results to a temporary markdown file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent, AgentBootOptions } from "./interface.js";
import type { IssueDetails } from "../datasources/interface.js";
import type { DispatchResult } from "../dispatcher.js";
import { log } from "../helpers/logger.js";

/** Options for the commit agent's `generate()` method. */
export interface CommitGenerateOptions {
  /** Git diff of the branch relative to the default branch */
  branchDiff: string;
  /** Issue details for context */
  issue: IssueDetails;
  /** Task dispatch results */
  taskResults: DispatchResult[];
  /** Working directory */
  cwd: string;
}

/** Structured result returned by the commit agent. */
export interface CommitResult {
  /** The generated conventional commit message */
  commitMessage: string;
  /** The generated PR title */
  prTitle: string;
  /** The generated PR description */
  prDescription: string;
  /** Whether generation succeeded */
  success: boolean;
  /** Error message if generation failed */
  error?: string;
  /** Path to the temp markdown file with the full output */
  outputPath?: string;
}

/** Commit agent — extends `Agent` with a `generate()` method. */
export interface CommitAgent extends Agent {
  /**
   * Generate commit message, PR title, and PR description from branch
   * changes and context. Writes results to a temp markdown file.
   */
  generate(opts: CommitGenerateOptions): Promise<CommitResult>;
}

/**
 * Boot the commit agent.
 *
 * @throws if `opts.provider` is not supplied.
 */
export async function boot(opts: AgentBootOptions): Promise<CommitAgent> {
  const { provider } = opts;

  if (!provider) {
    throw new Error(
      "Commit agent requires a provider instance in boot options"
    );
  }

  return {
    name: "commit",

    async generate(genOpts: CommitGenerateOptions): Promise<CommitResult> {
      try {
        const tmpDir = join(genOpts.cwd, ".dispatch", "tmp");
        await mkdir(tmpDir, { recursive: true });

        const tmpFilename = `commit-${randomUUID()}.md`;
        const tmpPath = join(tmpDir, tmpFilename);

        const prompt = buildCommitPrompt(genOpts);

        const sessionId = await provider.createSession();
        log.debug(`Commit prompt built (${prompt.length} chars)`);
        const response = await provider.prompt(sessionId, prompt);

        if (!response?.trim()) {
          return {
            commitMessage: "",
            prTitle: "",
            prDescription: "",
            success: false,
            error: "Commit agent returned empty response",
          };
        }

        log.debug(`Commit agent response (${response.length} chars)`);

        const parsed = parseCommitResponse(response);

        if (!parsed.commitMessage && !parsed.prTitle) {
          return {
            commitMessage: "",
            prTitle: "",
            prDescription: "",
            success: false,
            error:
              "Failed to parse commit agent response: no commit message or PR title found",
          };
        }

        const outputContent = formatOutputFile(parsed);
        await writeFile(tmpPath, outputContent, "utf-8");
        log.debug(`Wrote commit agent output to ${tmpPath}`);

        return {
          ...parsed,
          success: true,
          outputPath: tmpPath,
        };
      } catch (err) {
        const message = log.extractMessage(err);
        return {
          commitMessage: "",
          prTitle: "",
          prDescription: "",
          success: false,
          error: message,
        };
      }
    },

    async cleanup(): Promise<void> {
      // Commit agent has no owned resources — provider lifecycle is managed externally
    },
  };
}

/**
 * Build the prompt that instructs the AI to analyze the branch diff and
 * generate a conventional commit message, PR title, and PR description.
 */
export function buildCommitPrompt(opts: CommitGenerateOptions): string {
  const { branchDiff, issue, taskResults } = opts;

  const sections: string[] = [
    `You are a **commit message agent**. Your job is to analyze the git diff below and generate a meaningful, conventional-commit-compliant commit message, a PR title, and a PR description.`,
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

/**
 * Parse the AI agent's structured response into commit message, PR title,
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

/**
 * Format the parsed results into a markdown file for pipeline consumption.
 */
function formatOutputFile(parsed: {
  commitMessage: string;
  prTitle: string;
  prDescription: string;
}): string {
  const sections: string[] = [
    `# Commit Agent Output`,
    ``,
    `## Commit Message`,
    ``,
    parsed.commitMessage,
    ``,
    `## PR Title`,
    ``,
    parsed.prTitle,
    ``,
    `## PR Description`,
    ``,
    parsed.prDescription,
    ``,
  ];
  return sections.join("\n");
}
