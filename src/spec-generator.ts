/**
 * Spec generator — fetches issue details from an issue tracker, sends them
 * to the AI provider along with instructions to explore the codebase and
 * research the approach, then writes high-level markdown spec files that
 * can be consumed by the main `dispatch` command.
 *
 * Pipeline:
 *   1. Detect or validate the issue source (GitHub, Azure DevOps)
 *   2. Fetch each issue's details
 *   3. Boot the AI provider
 *   4. For each issue, prompt the AI to produce a spec file
 *   5. Write spec files to the output directory
 *
 * The generated specs stay high-level (WHAT, WHY, HOW) because the
 * planner agent in the dispatch pipeline handles detailed, line-level
 * implementation planning for each individual task.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem } from "node:os";
import type { ProviderInstance } from "./provider.js";
import type { IssueDetails, IssueFetchOptions, IssueSourceName } from "./issue-fetcher.js";
import { getIssueFetcher, detectIssueSource, ISSUE_SOURCE_NAMES } from "./issue-fetchers/index.js";
import type { ProviderName } from "./provider.js";
import { bootProvider } from "./providers/index.js";
import { log } from "./logger.js";

export interface SpecOptions {
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
  /** Output directory for spec files (default: .dispatch/specs) */
  outputDir?: string;
  /** Azure DevOps organization URL */
  org?: string;
  /** Azure DevOps project name */
  project?: string;
  /** Max parallel fetches/generations (default: min(cpuCount, freeMB/500)) */
  concurrency?: number;
}

export interface SpecSummary {
  /** Total issues requested */
  total: number;
  /** Successfully generated spec files */
  generated: number;
  /** Failed to generate */
  failed: number;
  /** Paths of generated spec files */
  files: string[];
}

/**
 * Main entry point for the --spec feature.
 */
export async function generateSpecs(opts: SpecOptions): Promise<SpecSummary> {
  const {
    issues,
    provider,
    serverUrl,
    cwd,
    outputDir = join(cwd, ".dispatch", "specs"),
    org,
    project,
    concurrency = Math.max(1, Math.min(cpus().length, Math.floor(freemem() / 1024 / 1024 / 500))),
  } = opts;

  // Parse issue numbers
  const issueNumbers = issues
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (issueNumbers.length === 0) {
    log.error("No issue numbers provided. Use --spec 1,2,3");
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

  // ── Fetch all issues (parallel batches) ─────────────────────
  log.info(`Fetching ${issueNumbers.length} issue(s) from ${source} (concurrency: ${concurrency})...`);

  const issueDetails: { id: string; details: IssueDetails | null; error?: string }[] = [];
  const fetchQueue = [...issueNumbers];

  while (fetchQueue.length > 0) {
    const batch = fetchQueue.splice(0, concurrency);
    log.debug(`Fetching batch of ${batch.length}: #${batch.join(", #")}`);
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        try {
          const details = await fetcher.fetch(id, fetchOpts);
          log.success(`Fetched #${id}: ${details.title}`);
          log.debug(`Body: ${details.body?.length ?? 0} chars, Labels: ${details.labels.length}, Comments: ${details.comments.length}`);
          return { id, details };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Failed to fetch #${id}: ${message}`);
          log.debug(log.formatErrorChain(err));
          return { id, details: null, error: message };
        }
      })
    );
    issueDetails.push(...batchResults);
  }

  const validIssues = issueDetails.filter((i) => i.details !== null);
  if (validIssues.length === 0) {
    log.error("No issues could be fetched. Aborting spec generation.");
    return { total: issueNumbers.length, generated: 0, failed: issueNumbers.length, files: [] };
  }

  // ── Boot AI provider ────────────────────────────────────────
  log.info(`Booting ${provider} provider...`);
  log.debug(serverUrl ? `Using server URL: ${serverUrl}` : "No --server-url, will spawn local server");
  const instance = await bootProvider(provider, { url: serverUrl, cwd });

  // ── Generate spec for each issue (parallel batches) ─────────
  await mkdir(outputDir, { recursive: true });

  const generatedFiles: string[] = [];
  let failed = issueDetails.filter((i) => i.details === null).length;

  const genQueue = [...validIssues];

  while (genQueue.length > 0) {
    const batch = genQueue.splice(0, concurrency);
    log.info(`Generating specs for batch of ${batch.length} (${generatedFiles.length + failed}/${issueNumbers.length} done)...`);

    const batchResults = await Promise.all(
      batch.map(async ({ id, details }) => {
        try {
          log.info(`Generating spec for #${id}: ${details!.title}...`);

          const spec = await generateSingleSpec(instance, details!, cwd);

          // Sanitize filename
          const slug = details!.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60);

          const filename = `${id}-${slug}.md`;
          const filepath = join(outputDir, filename);

          await writeFile(filepath, spec, "utf-8");
          log.success(`Spec written: ${filepath}`);

          // Push spec content back to the issue tracker
          if (fetcher.update) {
            try {
              const specTitle = details!.title;
              await fetcher.update(id, specTitle, spec, fetchOpts);
              log.success(`Updated issue #${id} with spec content`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.warn(`Could not update issue #${id}: ${message}`);
            }
          }

          return filepath;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Failed to generate spec for #${id}: ${message}`);
          log.debug(log.formatErrorChain(err));
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result !== null) {
        generatedFiles.push(result);
      } else {
        failed++;
      }
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────
  await instance.cleanup();

  log.info(
    `Spec generation complete: ${generatedFiles.length} generated, ${failed} failed`
  );

  if (generatedFiles.length > 0) {
    log.dim(`\n  Run these specs with:`);
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
 * Generate a single spec file by prompting the AI to explore the codebase
 * and produce a high-level task list that explains WHAT, WHY, and HOW.
 *
 * The generated file intentionally stays at a strategic level — a separate
 * planner agent runs during `dispatch` to produce detailed, line-level
 * implementation plans for each individual task.
 */
async function generateSingleSpec(
  instance: ProviderInstance,
  issue: IssueDetails,
  cwd: string
): Promise<string> {
  const sessionId = await instance.createSession();
  const prompt = buildSpecPrompt(issue, cwd);
  log.debug(`Spec prompt built (${prompt.length} chars)`);

  const response = await instance.prompt(sessionId, prompt);

  if (!response?.trim()) {
    throw new Error("AI returned an empty spec");
  }

  log.debug(`Spec response received (${response.length} chars)`);
  return response;
}

/**
 * Build the prompt that instructs the AI to explore the codebase,
 * understand the issue, and produce a high-level markdown spec file.
 *
 * The output emphasises WHAT needs to change, WHY it needs to change,
 * and HOW it fits into the existing project — but deliberately avoids
 * low-level implementation specifics (exact code, line numbers, diffs).
 * A dedicated planner agent handles that granularity per-task at
 * dispatch time.
 */
function buildSpecPrompt(issue: IssueDetails, cwd: string): string {
  const sections: string[] = [
    `You are a **spec agent**. Your job is to explore the codebase, understand the issue below, and produce a high-level **markdown spec file** that will drive an automated implementation pipeline.`,
    ``,
    `**Important:** This file will be consumed by a two-stage pipeline:`,
    `1. A **planner agent** reads each task together with the prose context in this file, then explores the codebase to produce a detailed, line-level implementation plan.`,
    `2. A **coder agent** follows that detailed plan to make the actual code changes.`,
    ``,
    `Because the planner agent handles low-level details, your output must stay **high-level and strategic**. Focus on the WHAT, WHY, and HOW — not exact code or line numbers.`,
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
    `1. **Explore the codebase** — read relevant files, search for symbols, understand the project structure, language, frameworks, conventions, and patterns. Identify the tech stack (languages, package managers, frameworks, test runners) so your spec aligns with the project's actual standards.`,
    ``,
    `2. **Understand the issue** — analyze the issue description, acceptance criteria, and discussion comments to fully understand what needs to be done and why.`,
    ``,
    `3. **Research the approach** — look up relevant documentation, libraries, and patterns. Consider how the change integrates with the existing architecture, standards, and technologies already in use. For example, if the project is TypeScript, do not propose a Python solution; if it uses Vitest, do not suggest Jest.`,
    ``,
    `4. **Identify integration points** — determine which existing modules, interfaces, patterns, and conventions the implementation must align with. Note the key files and modules involved, but do NOT prescribe exact code changes — the planner agent will handle that.`,
    ``,
    `5. **DO NOT make any changes** — you are only producing a spec, not implementing.`,
    ``,
    `## Output Format`,
    ``,
    `Produce your response as a **complete markdown file** that follows this exact structure. The file will be saved and later used with the \`dispatch\` command to execute the tasks.`,
    ``,
    `\`\`\``,
    `# <Issue title> (#<number>)`,
    ``,
    `> <One-line summary: what this issue achieves and why it matters>`,
    ``,
    `## Context`,
    ``,
    `<Describe the relevant parts of the codebase: key modules, directory structure,`,
    `language/framework, and architectural patterns. Name specific files and modules`,
    `that are involved so the planner agent knows where to look, but do not include`,
    `code snippets or line-level details.>`,
    ``,
    `## Why`,
    ``,
    `<Explain the motivation — why this change is needed, what problem it solves,`,
    `what user or system benefit it provides. Pull from the issue description,`,
    `acceptance criteria, and discussion.>`,
    ``,
    `## Approach`,
    ``,
    `<High-level description of the implementation strategy. Explain the overall`,
    `approach, which patterns to follow, what to extend vs. create new, and how`,
    `the change fits into the existing architecture. Mention relevant standards,`,
    `technologies, and conventions the implementation MUST align with.>`,
    ``,
    `## Integration Points`,
    ``,
    `<List the specific modules, interfaces, configurations, and conventions that`,
    `the implementation must integrate with. For example: existing provider`,
    `interfaces to implement, CLI argument patterns to follow, test framework`,
    `and conventions to match, build system requirements, etc.>`,
    ``,
    `## Tasks`,
    ``,
    `- [ ] First task — describe WHAT to do and WHY, not exactly HOW`,
    `- [ ] Second task — name the area/module affected and the goal`,
    `- [ ] Third task — mention integration requirements if relevant`,
    `- [ ] ...`,
    ``,
    `## References`,
    ``,
    `- <Links to relevant docs, related issues, or external resources>`,
    `\`\`\``,
    ``,
    `## Key Guidelines`,
    ``,
    `- **Stay high-level.** Do NOT include code snippets, exact line numbers, diffs, or step-by-step coding instructions. A dedicated planner agent will produce those details for each task at execution time.`,
    `- **Respect the project's stack.** Your spec must align with the languages, frameworks, libraries, test tools, and conventions already in use. Never suggest technologies that conflict with the existing project.`,
    `- **Explain WHAT, WHY, and HOW (strategically).** Each task should say what needs to happen, why it's needed, and which part of the codebase it touches — but leave the tactical "how" to the planner agent.`,
    `- **Detail integration points.** The prose sections (Context, Approach, Integration Points) are critical — they tell the planner agent where to look and what constraints to respect.`,
    `- **Keep tasks atomic and ordered.** Each \`- [ ]\` task must be a single, clear unit of work. Order them so dependencies come first.`,
    `- **Keep the markdown clean** — it will be parsed by an automated tool.`,
    `- Output ONLY the markdown content. Do not wrap it in a code fence or add any preamble/explanation outside the markdown.`,
  );

  return sections.join("\n");
}
