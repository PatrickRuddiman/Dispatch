/**
 * Plan generator — fetches issue details from an issue tracker, sends them
 * to the AI provider along with instructions to explore the codebase and
 * research the implementation, then writes comprehensive markdown task
 * files that can be consumed by the main `dispatch` command.
 *
 * Pipeline:
 *   1. Detect or validate the issue source (GitHub, Azure DevOps)
 *   2. Fetch each issue's details
 *   3. Boot the AI provider
 *   4. For each issue, prompt the AI to produce a task file
 *   5. Write task files to the output directory
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderInstance } from "./provider.js";
import type { IssueDetails, IssueFetchOptions, IssueSourceName } from "./issue-fetcher.js";
import { getIssueFetcher, detectIssueSource, ISSUE_SOURCE_NAMES } from "./issue-fetchers/index.js";
import type { ProviderName } from "./provider.js";
import { bootProvider } from "./providers/index.js";
import { log } from "./logger.js";

export interface PlanOptions {
  /** Comma-separated issue numbers */
  issues: string;
  /** Explicit issue source override (auto-detected if omitted) */
  issueSource?: IssueSourceName;
  /** AI agent backend */
  provider: ProviderName;
  /** URL of a running provider server */
  serverUrl?: string;
  /** Working directory */
  cwd: string;
  /** Output directory for plan files (default: .dispatch/plans) */
  outputDir?: string;
  /** Azure DevOps organization URL */
  org?: string;
  /** Azure DevOps project name */
  project?: string;
}

export interface PlanSummary {
  /** Total issues requested */
  total: number;
  /** Successfully generated plan files */
  generated: number;
  /** Failed to generate */
  failed: number;
  /** Paths of generated plan files */
  files: string[];
}

/**
 * Main entry point for the --plan feature.
 */
export async function generatePlans(opts: PlanOptions): Promise<PlanSummary> {
  const {
    issues,
    provider,
    serverUrl,
    cwd,
    outputDir = join(cwd, ".dispatch", "plans"),
    org,
    project,
  } = opts;

  // Parse issue numbers
  const issueNumbers = issues
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (issueNumbers.length === 0) {
    log.error("No issue numbers provided. Use --plan 1,2,3");
    return { total: 0, generated: 0, failed: 0, files: [] };
  }

  // ── Detect or validate issue source ─────────────────────────
  let source = opts.issueSource;
  if (!source) {
    log.info("Detecting issue source from git remote...");
    const detected = await detectIssueSource(cwd);
    if (!detected) {
      log.error(
        `Could not detect issue source from the repository remote URL.\n` +
        `  Supported sources: ${ISSUE_SOURCE_NAMES.join(", ")}\n` +
        `  Use --source <name> to specify explicitly, or ensure the git remote\n` +
        `  points to a supported platform (github.com, dev.azure.com).`
      );
      return { total: issueNumbers.length, generated: 0, failed: issueNumbers.length, files: [] };
    }
    source = detected;
    log.info(`Detected issue source: ${source}`);
  }

  const fetcher = getIssueFetcher(source);
  const fetchOpts: IssueFetchOptions = { cwd, org, project };

  // ── Fetch all issues ────────────────────────────────────────
  log.info(`Fetching ${issueNumbers.length} issue(s) from ${source}...`);

  const issueDetails: { id: string; details: IssueDetails | null; error?: string }[] = [];

  for (const id of issueNumbers) {
    try {
      const details = await fetcher.fetch(id, fetchOpts);
      issueDetails.push({ id, details });
      log.success(`Fetched #${id}: ${details.title}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issueDetails.push({ id, details: null, error: message });
      log.error(`Failed to fetch #${id}: ${message}`);
    }
  }

  const validIssues = issueDetails.filter((i) => i.details !== null);
  if (validIssues.length === 0) {
    log.error("No issues could be fetched. Aborting plan generation.");
    return { total: issueNumbers.length, generated: 0, failed: issueNumbers.length, files: [] };
  }

  // ── Boot AI provider ────────────────────────────────────────
  log.info(`Booting ${provider} provider...`);
  const instance = await bootProvider(provider, { url: serverUrl, cwd });

  // ── Generate plan for each issue ────────────────────────────
  await mkdir(outputDir, { recursive: true });

  const generatedFiles: string[] = [];
  let failed = issueDetails.filter((i) => i.details === null).length;

  for (const { id, details } of validIssues) {
    try {
      log.info(`Generating plan for #${id}: ${details!.title}...`);

      const plan = await generateSinglePlan(instance, details!, cwd);

      // Sanitize filename
      const slug = details!.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);

      const filename = `${id}-${slug}.md`;
      const filepath = join(outputDir, filename);

      await writeFile(filepath, plan, "utf-8");
      generatedFiles.push(filepath);

      log.success(`Plan written: ${filepath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to generate plan for #${id}: ${message}`);
      failed++;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────
  await instance.cleanup();

  log.info(
    `Plan generation complete: ${generatedFiles.length} generated, ${failed} failed`
  );

  if (generatedFiles.length > 0) {
    log.dim(`\n  Run these plans with:`);
    log.dim(`    dispatch "${outputDir}/*.md"\n`);
  }

  return {
    total: issueNumbers.length,
    generated: generatedFiles.length,
    failed,
    files: generatedFiles,
  };
}

/**
 * Generate a single plan file by prompting the AI to explore the codebase
 * and produce a comprehensive task list with implementation details.
 */
async function generateSinglePlan(
  instance: ProviderInstance,
  issue: IssueDetails,
  cwd: string
): Promise<string> {
  const sessionId = await instance.createSession();
  const prompt = buildPlanPrompt(issue, cwd);

  const response = await instance.prompt(sessionId, prompt);

  if (!response?.trim()) {
    throw new Error("AI returned an empty plan");
  }

  return response;
}

/**
 * Build the prompt that instructs the AI to explore the codebase,
 * understand the issue, research the implementation, and produce
 * a markdown task file with checkboxes and implementation details.
 */
function buildPlanPrompt(issue: IssueDetails, cwd: string): string {
  const sections: string[] = [
    `You are a **planning agent**. Your job is to explore the codebase, understand the issue below, research the best implementation approach, and produce a comprehensive **markdown task file** that another agent will use to implement the changes.`,
    ``,
    `## Issue Details`,
    ``,
    `- **Number:** #${issue.number}`,
    `- **Title:** ${issue.title}`,
    `- **State:** ${issue.state}`,
    `- **URL:** ${issue.url}`,
  ];

  if (issue.labels.length > 0) {
    sections.push(`- **Labels:** ${issue.labels.join(", ")}`);
  }

  if (issue.body) {
    sections.push(``, `### Description`, ``, issue.body);
  }

  if (issue.acceptanceCriteria) {
    sections.push(``, `### Acceptance Criteria`, ``, issue.acceptanceCriteria);
  }

  if (issue.comments.length > 0) {
    sections.push(``, `### Discussion`, ``);
    for (const comment of issue.comments) {
      sections.push(comment, ``);
    }
  }

  sections.push(
    ``,
    `## Working Directory`,
    ``,
    `\`${cwd}\``,
    ``,
    `## Instructions`,
    ``,
    `1. **Explore the codebase** — read relevant files, search for symbols, understand the project structure, conventions, and patterns. Pay attention to existing code style, architecture, and dependencies.`,
    ``,
    `2. **Understand the issue** — analyze the issue description, acceptance criteria, and discussion comments to fully understand what needs to be done.`,
    ``,
    `3. **Research the implementation** — look up relevant documentation, libraries, and patterns that would help implement this feature or fix. Consider best practices and potential edge cases.`,
    ``,
    `4. **DO NOT make any changes** — you are only planning, not executing.`,
    ``,
    `## Output Format`,
    ``,
    `Produce your response as a **complete markdown file** that follows this exact structure. The file will be saved and later used with the \`dispatch\` command to execute the tasks.`,
    ``,
    `\`\`\``,
    `# <Issue title> (#<number>)`,
    ``,
    `> <One-line summary of the issue and its goal>`,
    ``,
    `## Context`,
    ``,
    `<Brief description of the relevant parts of the codebase — which files,`,
    `modules, and patterns are involved. Include specific file paths.>`,
    ``,
    `## Requirements`,
    ``,
    `<Bullet list of concrete requirements extracted from the issue, acceptance`,
    `criteria, and discussion. Be specific and actionable.>`,
    ``,
    `## Implementation Details`,
    ``,
    `<Detailed technical notes for the implementer: approach, patterns to follow,`,
    `imports needed, type signatures, API conventions discovered in the codebase.`,
    `Include code snippets where helpful. Reference specific files and line numbers.>`,
    ``,
    `## Tasks`,
    ``,
    `- [ ] First task — clear, atomic, actionable description`,
    `- [ ] Second task — with enough detail to implement without guessing`,
    `- [ ] Third task — reference specific files and what to change`,
    `- [ ] ...`,
    ``,
    `## References`,
    ``,
    `- <Links to relevant files, docs, or resources>`,
    `\`\`\``,
    ``,
    `## Key Guidelines`,
    ``,
    `- Each \`- [ ]\` task must be **atomic** — one clear unit of work that can be completed independently.`,
    `- Tasks should be **ordered** — dependencies should come first.`,
    `- Include **enough context** in the implementation details that an agent with no prior knowledge of the codebase can complete the tasks.`,
    `- Reference **specific file paths** and code patterns you discovered.`,
    `- The prose sections (Context, Requirements, Implementation Details) are critical — they provide the context that guides the executor agent for every task in the file.`,
    `- Keep the markdown clean — it will be parsed by an automated tool.`,
    `- Output ONLY the markdown content. Do not wrap it in a code fence or add any preamble/explanation outside the markdown.`,
  );

  return sections.join("\n");
}
