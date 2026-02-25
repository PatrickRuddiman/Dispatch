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
 *   4. For each issue, tell the AI agent the target filepath and prompt it
 *      to explore the codebase and write the spec directly to disk
 *   5. Verify the spec file was written
 *
 * The generated specs stay high-level (WHAT, WHY, HOW) because the
 * planner agent in the dispatch pipeline handles detailed, line-level
 * implementation planning for each individual task.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { cpus, freemem } from "node:os";
import type { ProviderInstance } from "./provider.js";
import type { IssueDetails, IssueFetchOptions, IssueSourceName } from "./issue-fetcher.js";
import { getIssueFetcher, detectIssueSource, ISSUE_SOURCE_NAMES } from "./issue-fetchers/index.js";
import type { ProviderName } from "./provider.js";
import { bootProvider } from "./providers/index.js";
import { log } from "./logger.js";
import { registerCleanup } from "./cleanup.js";
import { glob } from "glob";

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

/** Returns a safe default concurrency: min(cpuCount, freeMB/500), at least 1. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(cpus().length, Math.floor(freemem() / 1024 / 1024 / 500)));
}

/**
 * Returns `true` when the input string consists solely of comma-separated
 * issue numbers (digits, commas, and optional whitespace).  Anything else
 * — paths, globs, filenames — returns `false`.
 *
 * This is the branching point for the two spec-generation code paths:
 * issue-tracker mode vs. local-file/glob mode.
 */
export function isIssueNumbers(input: string): boolean {
  return /^\d+(,\s*\d+)*$/.test(input);
}

/**
 * Post-process raw spec file content written by the AI agent.
 *
 * Strips code-fence wrapping, preamble text before the first H1 heading,
 * and postamble text after the last recognized spec section.  Returns the
 * content unchanged when no recognizable spec structure is found.
 *
 * Pure function — no I/O, no side-effects.
 */
export function extractSpecContent(raw: string): string {
  let content = raw;

  // 1. Strip code-fence wrapping (``` or ```markdown around entire content)
  //    The fence may wrap the entire input or may appear after preamble text,
  //    so we search for a fenced block containing an H1 heading.
  const fenceMatch = content.match(/^\s*```(?:markdown)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (fenceMatch) {
    content = fenceMatch[1];
  } else {
    // Try to find a fenced block that contains an H1, even with surrounding text
    const innerFenceMatch = content.match(/```(?:markdown)?\s*\n([\s\S]*?)\n\s*```/);
    if (innerFenceMatch && /^# /m.test(innerFenceMatch[1])) {
      content = innerFenceMatch[1];
    }
  }

  // 2. Remove preamble — everything before the first H1 heading
  const h1Index = content.search(/^# /m);
  if (h1Index === -1) {
    // No H1 found — return original content unchanged
    return raw;
  }
  content = content.slice(h1Index);

  // 3. Remove postamble — trim after the last recognized H2 section's content
  const RECOGNIZED_H2 = new Set([
    "## Context",
    "## Why",
    "## Approach",
    "## Integration Points",
    "## Tasks",
    "## References",
    "## Key Guidelines",
  ]);

  const lines = content.split("\n");
  let lastRecognizedSectionEnd = lines.length;

  // Walk backwards to find the last recognized H2 and its content extent
  let foundLastRecognized = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trimEnd();
    if (trimmed.startsWith("## ")) {
      if (RECOGNIZED_H2.has(trimmed)) {
        // This is the last recognized H2 — everything up to end is the section content
        foundLastRecognized = true;
        break;
      } else {
        // Unrecognized H2 — this and everything after it is postamble
        lastRecognizedSectionEnd = i;
      }
    }
  }

  if (foundLastRecognized || lastRecognizedSectionEnd < lines.length) {
    // Trim trailing blank lines from the kept portion
    let end = lastRecognizedSectionEnd;
    while (end > 0 && lines[end - 1].trim() === "") {
      end--;
    }
    content = lines.slice(0, end).join("\n");
  }

  // Ensure trailing newline
  if (!content.endsWith("\n")) {
    content += "\n";
  }

  return content;
}

export interface ValidationResult {
  /** Whether the spec content has valid structure */
  valid: boolean;
  /** Human-readable reason when validation fails */
  reason?: string;
}

/**
 * Validate that spec content has the expected structural markers.
 *
 * Checks:
 * 1. Content starts with an H1 heading (`# `)
 * 2. Contains a `## Tasks` section with at least one `- [ ]` checkbox
 *
 * This is a guardrail, not a gate — validation failures are warned but
 * do not block the pipeline. Returns a structured result so callers can
 * act on it.
 */
export function validateSpecStructure(content: string): ValidationResult {
  const trimmed = content.trimStart();

  // Check 1: Must start with an H1 heading
  if (!trimmed.startsWith("# ")) {
    const reason = "Spec does not start with an H1 heading (expected \"# \")";
    log.warn(reason);
    return { valid: false, reason };
  }

  // Check 2: Must contain a ## Tasks section
  const tasksIndex = content.search(/^## Tasks\s*$/m);
  if (tasksIndex === -1) {
    const reason = "Spec is missing a \"## Tasks\" section";
    log.warn(reason);
    return { valid: false, reason };
  }

  // Check 3: Must have at least one checkbox after ## Tasks
  const afterTasks = content.slice(tasksIndex);
  if (!/- \[ \]/.test(afterTasks)) {
    const reason = "\"## Tasks\" section contains no unchecked tasks (expected at least one \"- [ ]\")";
    log.warn(reason);
    return { valid: false, reason };
  }

  return { valid: true };
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
    concurrency = defaultConcurrency(),
  } = opts;

  // ── Route: file/glob mode vs. issue-tracker mode ────────────
  if (!isIssueNumbers(issues)) {
    return generateSpecsFromFiles(opts);
  }

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
  registerCleanup(() => instance.cleanup());

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
        // Compute the target filepath before prompting — the agent writes here directly
        const slug = details!.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60);

        const filename = `${id}-${slug}.md`;
        const filepath = join(outputDir, filename);

        try {
          log.info(`Generating spec for #${id}: ${details!.title}...`);

          const prompt = buildSpecPrompt(details!, cwd, filepath);
          await generateSingleSpec(instance, prompt, filepath);
          log.success(`Spec written: ${filepath}`);

          // Push spec content back to the issue tracker
          if (fetcher.update) {
            try {
              const specContent = await readFile(filepath, "utf-8");
              await fetcher.update(id, details!.title, specContent, fetchOpts);
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
 * Generate specs from local markdown files matched by a glob pattern.
 * The source file is read, a prompt is built from its content, and the
 * AI agent overwrites the file in-place with a structured spec.
 */
async function generateSpecsFromFiles(opts: SpecOptions): Promise<SpecSummary> {
  const {
    issues: pattern,
    provider,
    serverUrl,
    cwd,
    concurrency = defaultConcurrency(),
  } = opts;

  // ── Resolve glob ────────────────────────────────────────────
  const files = await glob(pattern, { cwd, absolute: true });

  if (files.length === 0) {
    log.error(`No files matched the pattern "${pattern}".`);
    return { total: 0, generated: 0, failed: 0, files: [] };
  }

  log.info(`Matched ${files.length} file(s) for spec generation (concurrency: ${concurrency})...`);

  // ── Boot AI provider ────────────────────────────────────────
  log.info(`Booting ${provider} provider...`);
  log.debug(serverUrl ? `Using server URL: ${serverUrl}` : "No --server-url, will spawn local server");
  const instance = await bootProvider(provider, { url: serverUrl, cwd });
  registerCleanup(() => instance.cleanup());

  // ── Generate spec for each file (parallel batches) ──────────
  const generatedFiles: string[] = [];
  let failed = 0;

  const genQueue = [...files];

  while (genQueue.length > 0) {
    const batch = genQueue.splice(0, concurrency);
    log.info(`Generating specs for batch of ${batch.length} (${generatedFiles.length + failed}/${files.length} done)...`);

    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        try {
          log.info(`Generating spec for ${filePath}...`);

          const content = await readFile(filePath, "utf-8");
          const prompt = buildFileSpecPrompt(filePath, content, cwd);
          await generateSingleSpec(instance, prompt, filePath);
          log.success(`Spec written: ${filePath}`);

          return filePath;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Failed to generate spec for ${filePath}: ${message}`);
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
    log.dim(`    dispatch ${files.map((f) => '"' + f + '"').join(" ")}\n`);
  }

  return {
    total: files.length,
    generated: generatedFiles.length,
    failed,
    files: generatedFiles,
  };
}

/**
 * Instruct the AI agent to generate and write a single spec file to disk.
 *
 * The agent is given a pre-built prompt and the exact output path, and is
 * expected to write the spec directly using its file tools. We then verify
 * the file exists.
 *
 * @throws if the agent session errors or the file is not present after the session
 */
async function generateSingleSpec(
  instance: ProviderInstance,
  prompt: string,
  outputPath: string
): Promise<void> {
  const sessionId = await instance.createSession();
  log.debug(`Spec prompt built (${prompt.length} chars)`);

  const response = await instance.prompt(sessionId, prompt);

  if (response === null) {
    throw new Error("AI agent returned no response");
  }

  log.debug(`Spec agent response (${response.length} chars)`);

  // Verify the agent wrote the file
  let rawContent: string;
  try {
    rawContent = await readFile(outputPath, "utf-8");
  } catch {
    throw new Error(
      `Spec agent did not write the file to ${outputPath}. ` +
      `Agent response: ${response.slice(0, 300)}`
    );
  }

  // Post-process: extract clean spec content
  const cleanedContent = extractSpecContent(rawContent);
  log.debug(`Post-processed spec (${rawContent.length} → ${cleanedContent.length} chars)`);

  // Validate structure
  const validation = validateSpecStructure(cleanedContent);
  if (!validation.valid) {
    log.warn(`Spec validation warning for ${outputPath}: ${validation.reason}`);
  }

  // Write back only if content changed
  if (cleanedContent !== rawContent) {
    await writeFile(outputPath, cleanedContent, "utf-8");
    log.debug(`Wrote cleaned spec back to ${outputPath}`);
  }
}

/**
 * Build the prompt that instructs the AI agent to explore the codebase,
 * understand the issue, and write a high-level markdown spec file to disk.
 *
 * The agent is responsible for writing the file — this is not a completion
 * API call. The output emphasises WHAT needs to change, WHY it needs to
 * change, and HOW it fits into the existing project — but deliberately
 * avoids low-level implementation specifics (exact code, line numbers,
 * diffs). A dedicated planner agent handles that granularity per-task at
 * dispatch time.
 */
function buildSpecPrompt(issue: IssueDetails, cwd: string, outputPath: string): string {
  const sections: string[] = [
    `You are a **spec agent**. Your job is to explore the codebase, understand the issue below, and write a high-level **markdown spec file** to disk that will drive an automated implementation pipeline.`,
    ``,
    `**Important:** This file will be consumed by a two-stage pipeline:`,
    `1. A **planner agent** reads each task together with the prose context in this file, then explores the codebase to produce a detailed, line-level implementation plan.`,
    `2. A **coder agent** follows that detailed plan to make the actual code changes.`,
    ``,
    `Because the planner agent handles low-level details, your spec must stay **high-level and strategic**. Focus on the WHAT, WHY, and HOW — not exact code or line numbers.`,
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
    `5. **DO NOT make any code changes** — you are only producing a spec, not implementing.`,
    ``,
    `## Output`,
    ``,
    `Write the complete spec as a markdown file to this exact path:`,
    ``,
    `\`${outputPath}\``,
    ``,
    `Use your Write tool to save the file. The file must follow this structure exactly:`,
    ``,
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
    `Each task MUST be prefixed with an execution-mode tag:`,
    ``,
    `- \`(P)\` — **Parallel-safe.** This task has no dependency on the output of a prior task and can run concurrently with other \`(P)\` tasks.`,
    `- \`(S)\` — **Serial / dependent.** This task depends on a prior task's output or modifies shared state that conflicts with concurrent work. It acts as a barrier: all preceding tasks complete before it starts, and it completes before subsequent tasks begin.`,
    ``,
    `**Default to \`(P)\`.** Most tasks are independent (e.g., adding a function in one module, writing tests in another). Only use \`(S)\` when a task genuinely depends on the result of a prior task (e.g., "refactor module X" followed by "update callers of module X").`,
    ``,
    `If a task has no \`(P)\` or \`(S)\` prefix, the system treats it as serial, so always tag explicitly.`,
    ``,
    `Example:`,
    ``,
    `- [ ] (P) Add validation helper to the form utils module`,
    `- [ ] (P) Add unit tests for the new validation helper`,
    `- [ ] (S) Refactor the form component to use the new validation helper`,
    `- [ ] (P) Update documentation for the form utils module`,
    ``,
    ``,
    `## References`,
    ``,
    `- <Links to relevant docs, related issues, or external resources>`,
    ``,
    `## Key Guidelines`,
    ``,
    `- **Stay high-level.** Do NOT include code snippets, exact line numbers, diffs, or step-by-step coding instructions. A dedicated planner agent will produce those details for each task at execution time.`,
    `- **Respect the project's stack.** Your spec must align with the languages, frameworks, libraries, test tools, and conventions already in use. Never suggest technologies that conflict with the existing project.`,
    `- **Explain WHAT, WHY, and HOW (strategically).** Each task should say what needs to happen, why it's needed, and which part of the codebase it touches — but leave the tactical "how" to the planner agent.`,
    `- **Detail integration points.** The prose sections (Context, Approach, Integration Points) are critical — they tell the planner agent where to look and what constraints to respect.`,
    `- **Keep tasks atomic and ordered.** Each \`- [ ]\` task must be a single, clear unit of work. Order them so dependencies come first.`,
    `- **Tag every task with \`(P)\` or \`(S)\`.** Default to \`(P)\` (parallel) unless the task depends on a prior task's output. Group related serial dependencies together and prefer parallelism to maximize throughput.`,
    `- **Embed commit instructions within task descriptions.** You control when commits happen. Instead of creating standalone commit tasks (which would fail — each task runs in an isolated agent session), include commit instructions at the end of implementation task descriptions at logical boundaries. For example: "Implement the validation helper and commit with a conventional commit message." Group related changes into a single commit where it makes logical sense, and use the project's conventional commit types: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`, \`style\`, \`perf\`, \`ci\`. Not every task needs a commit instruction — use your judgment to place them at logical boundaries.`,
    `- **Keep the markdown clean** — it will be parsed by an automated tool.`,
  );

  return sections.join("\n");
}

/**
 * Build a spec prompt from a local markdown file instead of an issue-tracker
 * issue.  The filename (basename without extension) serves as the title, and
 * the file content serves as the description.  The output path is the source
 * file itself (in-place overwrite).
 *
 * The output-format instructions, spec structure template, (P)/(S) tagging
 * rules, and agent guidelines are identical to those in `buildSpecPrompt()`.
 */
export function buildFileSpecPrompt(filePath: string, content: string, cwd: string): string {
  const title = basename(filePath, ".md");

  const sections: string[] = [
    `You are a **spec agent**. Your job is to explore the codebase, understand the content below, and write a high-level **markdown spec file** to disk that will drive an automated implementation pipeline.`,
    ``,
    `**Important:** This file will be consumed by a two-stage pipeline:`,
    `1. A **planner agent** reads each task together with the prose context in this file, then explores the codebase to produce a detailed, line-level implementation plan.`,
    `2. A **coder agent** follows that detailed plan to make the actual code changes.`,
    ``,
    `Because the planner agent handles low-level details, your spec must stay **high-level and strategic**. Focus on the WHAT, WHY, and HOW — not exact code or line numbers.`,
    ``,
    `## File Details`,
    ``,
    `- **Title:** ${title}`,
    `- **Source file:** ${filePath}`,
  ];

  if (content) {
    sections.push(``, `### Content`, ``, content);
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
    `2. **Understand the content** — analyze the file content to fully understand what needs to be done and why.`,
    ``,
    `3. **Research the approach** — look up relevant documentation, libraries, and patterns. Consider how the change integrates with the existing architecture, standards, and technologies already in use. For example, if the project is TypeScript, do not propose a Python solution; if it uses Vitest, do not suggest Jest.`,
    ``,
    `4. **Identify integration points** — determine which existing modules, interfaces, patterns, and conventions the implementation must align with. Note the key files and modules involved, but do NOT prescribe exact code changes — the planner agent will handle that.`,
    ``,
    `5. **DO NOT make any code changes** — you are only producing a spec, not implementing.`,
    ``,
    `## Output`,
    ``,
    `Write the complete spec as a markdown file to this exact path:`,
    ``,
    `\`${filePath}\``,
    ``,
    `Use your Write tool to save the file. The file must follow this structure exactly:`,
    ``,
    `# <Title>`,
    ``,
    `> <One-line summary: what this achieves and why it matters>`,
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
    `what user or system benefit it provides. Pull from the file content.>`,
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
    `Each task MUST be prefixed with an execution-mode tag:`,
    ``,
    `- \`(P)\` — **Parallel-safe.** This task has no dependency on the output of a prior task and can run concurrently with other \`(P)\` tasks.`,
    `- \`(S)\` — **Serial / dependent.** This task depends on a prior task's output or modifies shared state that conflicts with concurrent work. It acts as a barrier: all preceding tasks complete before it starts, and it completes before subsequent tasks begin.`,
    ``,
    `**Default to \`(P)\`.** Most tasks are independent (e.g., adding a function in one module, writing tests in another). Only use \`(S)\` when a task genuinely depends on the result of a prior task (e.g., "refactor module X" followed by "update callers of module X").`,
    ``,
    `If a task has no \`(P)\` or \`(S)\` prefix, the system treats it as serial, so always tag explicitly.`,
    ``,
    `Example:`,
    ``,
    `- [ ] (P) Add validation helper to the form utils module`,
    `- [ ] (P) Add unit tests for the new validation helper`,
    `- [ ] (S) Refactor the form component to use the new validation helper`,
    `- [ ] (P) Update documentation for the form utils module`,
    ``,
    ``,
    `## References`,
    ``,
    `- <Links to relevant docs, related issues, or external resources>`,
    ``,
    `## Key Guidelines`,
    ``,
    `- **Stay high-level.** Do NOT include code snippets, exact line numbers, diffs, or step-by-step coding instructions. A dedicated planner agent will produce those details for each task at execution time.`,
    `- **Respect the project's stack.** Your spec must align with the languages, frameworks, libraries, test tools, and conventions already in use. Never suggest technologies that conflict with the existing project.`,
    `- **Explain WHAT, WHY, and HOW (strategically).** Each task should say what needs to happen, why it's needed, and which part of the codebase it touches — but leave the tactical "how" to the planner agent.`,
    `- **Detail integration points.** The prose sections (Context, Approach, Integration Points) are critical — they tell the planner agent where to look and what constraints to respect.`,
    `- **Keep tasks atomic and ordered.** Each \`- [ ]\` task must be a single, clear unit of work. Order them so dependencies come first.`,
    `- **Tag every task with \`(P)\` or \`(S)\`.** Default to \`(P)\` (parallel) unless the task depends on a prior task's output. Group related serial dependencies together and prefer parallelism to maximize throughput.`,
    `- **Embed commit instructions within task descriptions.** You control when commits happen. Instead of creating standalone commit tasks (which would fail — each task runs in an isolated agent session), include commit instructions at the end of implementation task descriptions at logical boundaries. For example: "Implement the validation helper and commit with a conventional commit message." Group related changes into a single commit where it makes logical sense, and use the project's conventional commit types: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`, \`style\`, \`perf\`, \`ci\`. Not every task needs a commit instruction — use your judgment to place them at logical boundaries.`,
    `- **Keep the markdown clean** — it will be parsed by an automated tool.`,
  );

  return sections.join("\n");
}
