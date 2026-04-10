/**
 * Spec skill — generates high-level markdown spec files from issue details,
 * file content, or inline text.
 *
 * Stateless data object: defines prompt construction and result parsing
 * without coupling to any provider. The dispatcher handles execution,
 * timebox management, and provider interaction.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import type { Skill } from "./interface.js";
import type { SpecData } from "./types.js";
import type { IssueDetails } from "../datasources/interface.js";
import { extractSpecContent, validateSpecStructure, DEFAULT_SPEC_WARN_MIN } from "../spec-generator.js";
import { extractTitle } from "../datasources/md.js";
import { formatEnvironmentPrompt } from "../helpers/environment.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/** Runtime input for the spec skill. */
export interface SpecInput {
  /** Issue details (for tracker mode) — mutually exclusive with fileContent */
  issue?: IssueDetails;
  /** File path (for file/glob mode) — used as source file reference */
  filePath?: string;
  /** File content (for file/glob mode) — mutually exclusive with issue */
  fileContent?: string;
  /** Inline text (for inline text mode) — mutually exclusive with issue and fileContent */
  inlineText?: string;
  /** Working directory */
  cwd: string;
  /** Final output path where the spec should be written */
  outputPath: string;
  /** Temp file path the provider writes to (caller generates it) */
  tmpPath: string;
}

// ---------------------------------------------------------------------------
// Stateless skill definition
// ---------------------------------------------------------------------------

/** The spec skill — stateless, no provider coupling. */
export const specSkill: Skill<SpecInput, SpecData> = {
  name: "spec",

  buildPrompt(input: SpecInput): string {
    const { issue, filePath, fileContent, inlineText, cwd, tmpPath } = input;

    if (issue) {
      return buildSpecPrompt(issue, cwd, tmpPath);
    }
    if (inlineText) {
      return buildInlineTextSpecPrompt(inlineText, cwd, tmpPath);
    }
    if (filePath && fileContent !== undefined) {
      return buildFileSpecPrompt(filePath, fileContent, cwd, tmpPath);
    }

    throw new Error("Either issue, inlineText, or filePath+fileContent must be provided");
  },

  async parseResult(response: string | null, input: SpecInput): Promise<SpecData> {
    if (response === null) {
      throw new Error("AI returned no response");
    }

    // 1. Read the temp file written by the provider
    let rawContent: string;
    try {
      rawContent = await readFile(input.tmpPath, "utf-8");
    } catch {
      throw new Error(
        `Spec skill did not write the file to ${input.tmpPath}. Response: ${response.slice(0, 300)}`
      );
    }

    // 2. Apply extractSpecContent post-processing
    const cleanedContent = extractSpecContent(rawContent);

    // 3. Run validateSpecStructure
    const validation = validateSpecStructure(cleanedContent);

    // 4. Write the cleaned content to the final output path
    await writeFile(input.outputPath, cleanedContent, "utf-8");

    // 5. Clean up the temp file
    try {
      await unlink(input.tmpPath);
    } catch {
      // Ignore cleanup errors — temp file may already be gone
    }

    // 6. Return SpecData
    if (validation.valid) {
      return { content: cleanedContent, valid: true };
    }
    return { content: cleanedContent, valid: false, validationReason: validation.reason };
  },
};

// ---------------------------------------------------------------------------
// Source section builders (private)
// ---------------------------------------------------------------------------

function buildIssueSourceSection(issue: IssueDetails): string[] {
  const lines: string[] = [
    ``,
    `## Issue Details`,
    ``,
    `- **Number:** #${issue.number}`,
    `- **Title:** ${issue.title}`,
    `- **State:** ${issue.state}`,
    `- **URL:** ${issue.url}`,
  ];

  if (issue.labels.length > 0) {
    lines.push(`- **Labels:** ${issue.labels.join(", ")}`);
  }

  if (issue.body) {
    lines.push(``, `### Description`, ``, issue.body);
  }

  if (issue.acceptanceCriteria) {
    lines.push(``, `### Acceptance Criteria`, ``, issue.acceptanceCriteria);
  }

  if (issue.comments.length > 0) {
    lines.push(``, `### Discussion`, ``);
    for (const comment of issue.comments) {
      lines.push(comment, ``);
    }
  }

  return lines;
}

function buildFileSourceSection(filePath: string, content: string, title: string): string[] {
  const lines: string[] = [
    ``,
    `## File Details`,
    ``,
    `- **Title:** ${title}`,
    `- **Source file:** ${filePath}`,
  ];

  if (content) {
    lines.push(``, `### Content`, ``, content);
  }

  return lines;
}

function buildInlineTextSourceSection(title: string, text: string): string[] {
  return [
    ``,
    `## Inline Text`,
    ``,
    `- **Title:** ${title}`,
    ``,
    `### Description`,
    ``,
    text,
  ];
}

// ---------------------------------------------------------------------------
// Common spec instructions builder (private)
// ---------------------------------------------------------------------------

function buildCommonSpecInstructions(params: {
  subject: string;
  sourceSection: string[];
  cwd: string;
  outputPath: string;
  understandStep: string;
  titleTemplate: string;
  summaryTemplate: string;
  whyLines: string[];
}): string[] {
  const {
    subject,
    sourceSection,
    cwd,
    outputPath,
    understandStep,
    titleTemplate,
    summaryTemplate,
    whyLines,
  } = params;

  return [
    `Explore the codebase, understand ${subject}, and write a high-level **markdown spec file** to disk that will drive an automated implementation pipeline.`,
    ``,
    `**Time limit:** You have ${DEFAULT_SPEC_WARN_MIN} minutes to complete this spec. Work efficiently and focus on delivering a complete, well-structured spec within this window.`,
    ``,
    `**Important:** This file will be consumed by a two-stage pipeline:`,
    `1. A **planner** reads each task together with the prose context in this file, then explores the codebase to produce a detailed, line-level implementation plan.`,
    `2. A **coder** follows that detailed plan to make the actual code changes.`,
    ``,
    `Because the planner handles low-level details, your spec must stay **high-level and strategic**. Focus on the WHAT, WHY, and HOW — not exact code or line numbers.`,
    ``,
    `**Scope:** Each invocation is scoped to exactly one source item. The source item for this invocation is the single passed issue, file, or inline request shown below.`,
    `Treat other repository materials — including existing spec files, sibling issues, and future work — as context only unless the passed source explicitly references them as required context.`,
    `Do not merge unrelated specs, issues, files, or requests into the generated output.`,
    ``,
    `**CRITICAL — Output constraints (read carefully):**`,
    `The file you write must contain ONLY the structured spec content described below. You MUST NOT include:`,
    `- **No preamble:** Do not add any text before the H1 heading (e.g., "Here's the spec:", "I've written the spec file to...")`,
    `- **No postamble:** Do not add any text after the last spec section (e.g., "Let me know if you'd like changes", "Here's a summary of...")`,
    `- **No summaries:** Do not append a summary or recap of what you wrote`,
    `- **No code fences:** Do not wrap the spec content in \`\`\`markdown ... \`\`\` or any other code fence`,
    `- **No conversational text:** Do not include any explanations, commentary, or dialogue — the file is consumed by an automated pipeline, not a human`,
    `The file content must start with \`# \` (the H1 heading) and contain nothing before or after the structured spec sections.`,
    ...sourceSection,
    ``,
    `## Working Directory`,
    ``,
    `\`${cwd}\``,
    ``,
    formatEnvironmentPrompt(),
    ``,
    `## Instructions`,
    ``,
    `1. **Explore the codebase** — read relevant files, search for symbols, understand the project structure, language, frameworks, conventions, and patterns. Identify the tech stack (languages, package managers, frameworks, test runners) so your spec aligns with the project's actual standards.`,
    ``,
    understandStep,
    ``,
    `3. **Research the approach** — look up relevant documentation, libraries, and patterns. Consider how the change integrates with the existing architecture, standards, and technologies already in use. For example, if the project is TypeScript, do not propose a Python solution; if it uses Vitest, do not suggest Jest.`,
    ``,
    `4. **Identify integration points** — determine which existing modules, interfaces, patterns, and conventions the implementation must align with. Note the key files and modules involved, but do NOT prescribe exact code changes — the planner will handle that.`,
    ``,
    `5. **DO NOT make any code changes** — you are only producing a spec, not implementing.`,
    ``,
    `## Output`,
    ``,
    `Write the complete spec as a markdown file to this exact path:`,
    ``,
    `\`${outputPath}\``,
    ``,
    `Use your Write tool to save the file. The file content MUST begin with the H1 heading — no preamble, no code fences, no conversational text before it. Do not add any text after the final spec section — no postamble, no summary, no commentary. The file must follow this structure exactly:`,
    ``,
    titleTemplate,
    ``,
    summaryTemplate,
    ``,
    `## Context`,
    ``,
    `<Describe the relevant parts of the codebase: key modules, directory structure,`,
    `language/framework, and architectural patterns. Name specific files and modules`,
    `that are involved so the planner knows where to look, but do not include`,
    `code snippets or line-level details.>`,
    ``,
    `## Why`,
    ``,
    `<Explain the motivation — why this change is needed, what problem it solves,`,
    ...whyLines,
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
    `- \`(I)\` — **Isolated / barrier.** This task must run alone after all preceding tasks complete and before any subsequent tasks begin. Use for validation tasks like running tests, linting, or builds that read the output of prior tasks.`,
    ``,
    `**Default to \`(P)\`.** Most tasks are independent (e.g., adding a function in one module, writing tests in another). Only use \`(S)\` when a task genuinely depends on the result of a prior task (e.g., "refactor module X" followed by "update callers of module X"). Use \`(I)\` for validation or barrier tasks that must run alone after all prior work completes (e.g., "run tests", "run linting", "build the project").`,
    ``,
    `If a task has no \`(P)\`, \`(S)\`, or \`(I)\` prefix, the system treats it as serial, so always tag explicitly.`,
    ``,
    `Example:`,
    ``,
    `- [ ] (P) Add validation helper to the form utils module`,
    `- [ ] (P) Add unit tests for the new validation helper`,
    `- [ ] (S) Refactor the form component to use the new validation helper`,
    `- [ ] (P) Update documentation for the form utils module`,
    `- [ ] (I) Run the full test suite to verify all changes pass`,
    ``,
    ``,
    `## References`,
    ``,
    `- <Links to relevant docs, related issues, or external resources>`,
    ``,
    `## Key Guidelines`,
    ``,
    `- **Stay high-level.** Do NOT include code snippets, exact line numbers, diffs, or step-by-step coding instructions. A dedicated planner will produce those details for each task at execution time.`,
    `- **Respect the project's stack.** Your spec must align with the languages, frameworks, libraries, test tools, and conventions already in use. Never suggest technologies that conflict with the existing project.`,
    `- **Explain WHAT, WHY, and HOW (strategically).** Each task should say what needs to happen, why it's needed, and which part of the codebase it touches — but leave the tactical "how" to the planner.`,
    `- **Detail integration points.** The prose sections (Context, Approach, Integration Points) are critical — they tell the planner where to look and what constraints to respect.`,
    `- **Keep tasks atomic and ordered.** Each \`- [ ]\` task must be a single, clear unit of work. Order them so dependencies come first.`,
    `- **Tag every task with \`(P)\`, \`(S)\`, or \`(I)\`.** Default to \`(P)\` (parallel) unless the task depends on a prior task's output. Use \`(I)\` for validation/barrier tasks. Group related serial dependencies together and prefer parallelism to maximize throughput.`,
    `- **Embed commit instructions within task descriptions.** You control when commits happen. Instead of creating standalone commit tasks (which would fail — each task runs in an isolated session), include commit instructions at the end of implementation task descriptions at logical boundaries. For example: "Implement the validation helper and commit with a conventional commit message." Group related changes into a single commit where it makes logical sense, and use the project's conventional commit types: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`, \`style\`, \`perf\`, \`ci\`. Not every task needs a commit instruction — use your judgment to place them at logical boundaries.`,
    `- **Keep the markdown clean** — it will be parsed by an automated tool.`,
  ];
}

// ---------------------------------------------------------------------------
// Public prompt builders (exported — tests use them directly)
// ---------------------------------------------------------------------------

/**
 * Build the prompt for tracker/issue mode.
 */
export function buildSpecPrompt(issue: IssueDetails, cwd: string, outputPath: string): string {
  return buildCommonSpecInstructions({
    subject: "the issue below",
    sourceSection: buildIssueSourceSection(issue),
    cwd,
    outputPath,
    understandStep: `2. **Understand the issue** — analyze the issue description, acceptance criteria, and discussion comments to fully understand what needs to be done and why.`,
    titleTemplate: `# <Issue title> (#<number>)`,
    summaryTemplate: `> <One-line summary: what this issue achieves and why it matters>`,
    whyLines: [
      `what user or system benefit it provides. Pull from the issue description,`,
      `acceptance criteria, and discussion.>`,
    ],
  }).join("\n");
}

/**
 * Build a spec prompt from a local markdown file.
 */
export function buildFileSpecPrompt(filePath: string, content: string, cwd: string, outputPath?: string): string {
  const title = extractTitle(content, filePath);
  const writePath = outputPath ?? filePath;

  return buildCommonSpecInstructions({
    subject: "the content below",
    sourceSection: buildFileSourceSection(filePath, content, title),
    cwd,
    outputPath: writePath,
    understandStep: `2. **Understand the content** — analyze the file content to fully understand what needs to be done and why.`,
    titleTemplate: `# <Title>`,
    summaryTemplate: `> <One-line summary: what this achieves and why it matters>`,
    whyLines: [
      `what user or system benefit it provides. Pull from the file content.>`,
    ],
  }).join("\n");
}

/**
 * Build a spec prompt from inline text.
 */
export function buildInlineTextSpecPrompt(text: string, cwd: string, outputPath: string): string {
  const title = text.length > 80 ? text.slice(0, 80).trimEnd() + "\u2026" : text;

  return buildCommonSpecInstructions({
    subject: "the request below",
    sourceSection: buildInlineTextSourceSection(title, text),
    cwd,
    outputPath,
    understandStep: `2. **Understand the request** — analyze the inline text to fully understand what needs to be done and why. Since this is a brief description rather than a detailed issue or document, you may need to infer details from the codebase.`,
    titleTemplate: `# <Title>`,
    summaryTemplate: `> <One-line summary: what this achieves and why it matters>`,
    whyLines: [
      `what user or system benefit it provides. Pull from the inline text description.>`,
    ],
  }).join("\n");
}
