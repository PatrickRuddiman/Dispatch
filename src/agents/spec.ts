/**
 * Spec agent — generates high-level markdown spec files from issue details
 * or file content by interacting with an AI provider.
 *
 * The spec agent follows the same pattern as the planner agent: it receives
 * a provider instance at boot time and exposes a `generate()` method for
 * producing specs. It writes to a temp file in `.dispatch/tmp/`, post-processes
 * and validates the content, then writes the cleaned result to the final
 * output path.
 */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent, AgentBootOptions } from "./interface.js";
import type { AgentResult, SpecData } from "./types.js";
import type { IssueDetails } from "../datasources/interface.js";
import type { ProviderProgressSnapshot } from "../providers/interface.js";
import { extractSpecContent, validateSpecStructure, DEFAULT_SPEC_WARN_MIN, DEFAULT_SPEC_KILL_MIN } from "../spec-generator.js";
import { TimeoutError } from "../helpers/timeout.js";
import { extractTitle } from "../datasources/md.js";
import { log } from "../helpers/logger.js";
import { fileLoggerStorage } from "../helpers/file-logger.js";
import { formatEnvironmentPrompt } from "../helpers/environment.js";

/**
 * Options passed to the spec agent's `generate()` method.
 */
export interface SpecGenerateOptions {
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
  /** Worktree root directory for isolation, if operating in a worktree */
  worktreeRoot?: string;
  /** Optional provider progress callback */
  onProgress?: (snapshot: ProviderProgressSnapshot) => void;
  /** Warn-phase duration in ms — fires "wrap up" message after this period */
  timeboxWarnMs?: number;
  /** Kill-phase duration in ms — hard-kills the prompt after warn + this period */
  timeboxKillMs?: number;
}

/**
 * A booted spec agent that can generate spec files.
 */
export interface SpecAgent extends Agent {
  /**
   * Generate a single spec. Creates an isolated session, instructs the AI
   * to write to a temp file, post-processes and validates the content,
   * writes the cleaned result to the final output path, and cleans up.
   */
  generate(opts: SpecGenerateOptions): Promise<AgentResult<SpecData>>;
}

/**
 * Boot a spec agent backed by the given provider.
 *
 * @throws if `opts.provider` is not supplied — the spec agent requires a
 *         provider to create sessions and send prompts.
 */
export async function boot(opts: AgentBootOptions): Promise<SpecAgent> {
  const { provider } = opts;

  if (!provider) {
    throw new Error("Spec agent requires a provider instance in boot options");
  }

  return {
    name: "spec",

    async generate(genOpts: SpecGenerateOptions): Promise<AgentResult<SpecData>> {
      const { issue, filePath, fileContent, inlineText, cwd: workingDir, outputPath, onProgress } = genOpts;
      const startTime = Date.now();

      try {
        // 0. Normalize cwd and validate outputPath stays within it
        const resolvedCwd = resolve(workingDir);
        const resolvedOutput = resolve(outputPath);
        if (
          resolvedOutput !== resolvedCwd &&
          !resolvedOutput.startsWith(resolvedCwd + sep)
        ) {
          return {
            data: null,
            success: false,
            error: `Output path "${outputPath}" escapes the working directory "${workingDir}"`,
            durationMs: Date.now() - startTime,
          };
        }

        // 1. Create .dispatch/tmp/ on demand
        const tmpDir = join(resolvedCwd, ".dispatch", "tmp");
        await mkdir(tmpDir, { recursive: true });

        // 2. Generate a unique temp file path
        const tmpFilename = `spec-${randomUUID()}.md`;
        const tmpPath = join(tmpDir, tmpFilename);

        // 3. Build the appropriate prompt, pointing at the temp file path
        let prompt: string;
        if (issue) {
          prompt = buildSpecPrompt(issue, workingDir, tmpPath);
        } else if (inlineText) {
          prompt = buildInlineTextSpecPrompt(inlineText, workingDir, tmpPath);
        } else if (filePath && fileContent !== undefined) {
          prompt = buildFileSpecPrompt(filePath, fileContent, workingDir, tmpPath);
        } else {
          return {
            data: null,
            success: false,
            error: "Either issue, inlineText, or filePath+fileContent must be provided",
            durationMs: Date.now() - startTime,
          };
        }

        fileLoggerStorage.getStore()?.prompt("spec", prompt);

        // 4. Create a session via the provider and send the prompt
        const sessionId = await provider.createSession();
        log.debug(`Spec prompt built (${prompt.length} chars)`);

        // 5. Run prompt with two-phase timebox
        const warnMs = genOpts.timeboxWarnMs ?? DEFAULT_SPEC_WARN_MIN * 60_000;
        const killMs = genOpts.timeboxKillMs ?? DEFAULT_SPEC_KILL_MIN * 60_000;

        const response = await new Promise<string | null>((resolve, reject) => {
          let settled = false;
          let warnTimer: ReturnType<typeof setTimeout> | undefined;
          let killTimer: ReturnType<typeof setTimeout> | undefined;

          const cleanup = () => {
            if (warnTimer) clearTimeout(warnTimer);
            if (killTimer) clearTimeout(killTimer);
          };

          // Start the warn timer
          warnTimer = setTimeout(() => {
            if (settled) return;
            const remainingSec = Math.round(killMs / 1000);
            const warnMessage =
              `Your spec generation time is done. You have exceeded the ${Math.round(warnMs / 60_000)}-minute limit. ` +
              `You MUST write the spec file to "${outputPath}" immediately. ` +
              `If you do not comply within ${remainingSec} seconds, you will be terminated.`;
            log.warn(`Timebox warn fired for session ${sessionId} — sending wrap-up message`);

            if (provider.send) {
              provider.send(sessionId, warnMessage).catch((err) => {
                log.warn(`Failed to send timebox warning: ${log.extractMessage(err)}`);
              });
            } else {
              log.warn(`Provider does not support send() — cannot deliver timebox warning`);
            }

            // Start the kill timer
            killTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new TimeoutError(warnMs + killMs, "spec timebox"));
            }, killMs);
          }, warnMs);

          // Run the prompt
          provider.prompt(sessionId, prompt, { onProgress }).then(
            (value) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(value);
            },
            (err) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            },
          );
        });

        if (response === null) {
          return {
            data: null,
            success: false,
            error: "AI agent returned no response",
            durationMs: Date.now() - startTime,
          };
        }

        log.debug(`Spec agent response (${response.length} chars)`);
        fileLoggerStorage.getStore()?.response("spec", response);

        // 6. Read the temp file
        let rawContent: string;
        try {
          rawContent = await readFile(tmpPath, "utf-8");
        } catch {
          return {
            data: null,
            success: false,
            error: `Spec agent did not write the file to ${tmpPath}. Agent response: ${response.slice(0, 300)}`,
            durationMs: Date.now() - startTime,
          };
        }

        // 7. Apply extractSpecContent post-processing
        const cleanedContent = extractSpecContent(rawContent);
        log.debug(`Post-processed spec (${rawContent.length} → ${cleanedContent.length} chars)`);

        // 8. Run validateSpecStructure
        const validation = validateSpecStructure(cleanedContent);
        if (!validation.valid) {
          log.warn(`Spec validation warning for ${outputPath}: ${validation.reason}`);
        }

        // 9. Write the cleaned content to the final output path
        await writeFile(resolvedOutput, cleanedContent, "utf-8");
        log.debug(`Wrote cleaned spec to ${resolvedOutput}`);

        // 10. Clean up the temp file
        try {
          await unlink(tmpPath);
        } catch {
          // Ignore cleanup errors — temp file may already be gone
        }

        fileLoggerStorage.getStore()?.agentEvent("spec", "completed", `${Date.now() - startTime}ms`);
        return {
          data: validation.valid
            ? { content: cleanedContent, valid: true }
            : { content: cleanedContent, valid: false, validationReason: validation.reason },
          success: true,
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        const message = log.extractMessage(err);
        fileLoggerStorage.getStore()?.error(`spec error: ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
        return {
          data: null,
          success: false,
          error: message,
          durationMs: Date.now() - startTime,
        };
      }
    },

    async cleanup(): Promise<void> {
      // Spec agent has no owned resources — provider lifecycle is managed externally
    },
  };
}

/**
 * Build the source-specific section for tracker/issue mode.
 */
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

/**
 * Build the source-specific section for file/glob mode.
 */
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

/**
 * Build the source-specific section for inline text mode.
 */
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

/**
 * Build the full spec prompt by assembling role preamble, pipeline explanation,
 * output constraints, source-specific section, working directory, instructions,
 * output template, task tagging rules, references, and key guidelines.
 *
 * All three public prompt builders delegate to this function with their
 * source-specific parameters.
 */
function buildCommonSpecInstructions(params: {
  /** Subject phrase for the role preamble (e.g., "the issue below"). */
  subject: string;
  /** Source-specific section lines to insert after output constraints. */
  sourceSection: string[];
  /** Working directory path. */
  cwd: string;
  /** Output file path. */
  outputPath: string;
  /** Full text of instruction step 2. */
  understandStep: string;
  /** Title template line for the spec structure. */
  titleTemplate: string;
  /** One-line summary template line. */
  summaryTemplate: string;
  /** Variable ending lines for the "Why" section template. */
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
    `You are a **spec agent**. Your job is to explore the codebase, understand ${subject}, and write a high-level **markdown spec file** to disk that will drive an automated implementation pipeline.`,
    ``,
    `**Time limit:** You have ${DEFAULT_SPEC_WARN_MIN} minutes to complete this spec. Work efficiently and focus on delivering a complete, well-structured spec within this window.`,
    ``,
    `**Important:** This file will be consumed by a two-stage pipeline:`,
    `1. A **planner agent** reads each task together with the prose context in this file, then explores the codebase to produce a detailed, line-level implementation plan.`,
    `2. A **coder agent** follows that detailed plan to make the actual code changes.`,
    ``,
    `Because the planner agent handles low-level details, your spec must stay **high-level and strategic**. Focus on the WHAT, WHY, and HOW — not exact code or line numbers.`,
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
    `that are involved so the planner agent knows where to look, but do not include`,
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
    `- **Stay high-level.** Do NOT include code snippets, exact line numbers, diffs, or step-by-step coding instructions. A dedicated planner agent will produce those details for each task at execution time.`,
    `- **Respect the project's stack.** Your spec must align with the languages, frameworks, libraries, test tools, and conventions already in use. Never suggest technologies that conflict with the existing project.`,
    `- **Explain WHAT, WHY, and HOW (strategically).** Each task should say what needs to happen, why it's needed, and which part of the codebase it touches — but leave the tactical "how" to the planner agent.`,
    `- **Detail integration points.** The prose sections (Context, Approach, Integration Points) are critical — they tell the planner agent where to look and what constraints to respect.`,
    `- **Keep tasks atomic and ordered.** Each \`- [ ]\` task must be a single, clear unit of work. Order them so dependencies come first.`,
    `- **Tag every task with \`(P)\`, \`(S)\`, or \`(I)\`.** Default to \`(P)\` (parallel) unless the task depends on a prior task's output. Use \`(I)\` for validation/barrier tasks. Group related serial dependencies together and prefer parallelism to maximize throughput.`,
    `- **Embed commit instructions within task descriptions.** You control when commits happen. Instead of creating standalone commit tasks (which would fail — each task runs in an isolated agent session), include commit instructions at the end of implementation task descriptions at logical boundaries. For example: "Implement the validation helper and commit with a conventional commit message." Group related changes into a single commit where it makes logical sense, and use the project's conventional commit types: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`, \`style\`, \`perf\`, \`ci\`. Not every task needs a commit instruction — use your judgment to place them at logical boundaries.`,
    `- **Keep the markdown clean** — it will be parsed by an automated tool.`,
  ];
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
 * Build a spec prompt from a local markdown file instead of an issue-tracker
 * issue.  The title is extracted from the first `# Heading` in the content,
 * falling back to the filename without extension.  The file content serves as
 * the description.
 *
 * When `outputPath` is provided, the prompt instructs the AI to write to that
 * path instead of the source file.  When omitted, the source `filePath` is
 * used as the output target (in-place overwrite), preserving backward
 * compatibility with existing callers.
 *
 * The output-format instructions, spec structure template, (P)/(S) tagging
 * rules, and agent guidelines are identical to those in `buildSpecPrompt()`.
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
 * Build a spec prompt from inline text provided directly on the command line.
 *
 * Unlike `buildFileSpecPrompt()`, there is no source file — the user's text
 * serves as both the title and the description.  The output-format
 * instructions, spec structure template, (P)/(S) tagging rules, and agent
 * guidelines are identical to those in `buildSpecPrompt()` and
 * `buildFileSpecPrompt()`.
 */
export function buildInlineTextSpecPrompt(text: string, cwd: string, outputPath: string): string {
  const title = text.length > 80 ? text.slice(0, 80).trimEnd() + "…" : text;

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
