/**
 * Spec generator — fetches issue details from a configured datasource
 * (GitHub, Azure DevOps, or local markdown files), sends them to the AI
 * provider along with instructions to explore the codebase and research
 * the approach, then writes high-level markdown spec files.
 *
 * Pipeline:
 *   1. Resolve the datasource (explicit or auto-detected)
 *   2. Fetch issue/file details via the datasource
 *   3. Boot the AI provider
 *   4. For each item, tell the AI agent the target filepath and prompt it
 *      to explore the codebase and write the spec directly to disk
 *   5. Verify the spec file was written
 *   6. Push spec content back to the datasource via update()
 *
 * The generated specs stay high-level (WHAT, WHY, HOW) because the
 * planner agent in the dispatch pipeline handles detailed, line-level
 * implementation planning for each individual task.
 */

import { cpus, freemem } from "node:os";
import type { DatasourceName } from "./datasources/interface.js";
import { getDatasource, detectDatasource, DATASOURCE_NAMES } from "./datasources/index.js";
import type { ProviderName } from "./providers/interface.js";
import { log } from "./logger.js";

export interface SpecOptions {
  /** Comma-separated issue numbers, glob pattern(s), or "list" to use datasource.list() */
  issues: string | string[];
  /** Explicit datasource override (auto-detected if omitted) */
  issueSource?: DatasourceName;
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
export function isIssueNumbers(input: string | string[]): input is string {
  if (Array.isArray(input)) return false;
  return /^\d+(,\s*\d+)*$/.test(input);
}

/**
 * Returns `true` when the input looks like a glob pattern or file path
 * rather than free-form inline text.
 *
 * Checks for:
 * - Glob metacharacters: `*`, `?`, `[`, `{`
 * - Path separators: `/`, `\`
 * - Dot-prefix relative paths: `./`, `../`
 * - Common file extensions: `.md`, `.txt`, `.yaml`, `.yml`, `.json`, `.ts`,
 *   `.js`, `.tsx`, `.jsx`
 *
 * This is a pure function intended to be called *after* `isIssueNumbers()`
 * has already returned `false`, providing the second level of input
 * discrimination for the spec pipeline.
 */
export function isGlobOrFilePath(input: string | string[]): boolean {
  if (Array.isArray(input)) return true;
  // Glob metacharacters
  if (/[*?\[{]/.test(input)) return true;

  // Path separators (forward slash or backslash)
  if (/[/\\]/.test(input)) return true;

  // Dot-prefix relative paths (./something or ../something)
  if (/^\.\.?\//.test(input)) return true;

  // Common file extensions at end of string
  if (/\.(md|txt|yaml|yml|json|ts|js|tsx|jsx)$/i.test(input)) return true;

  return false;
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

/**
 * Resolve the datasource name for a spec-generation run.
 *
 * Priority:
 *   1. Explicit `issueSource` (from --source flag or config) — always wins.
 *   2. Auto-detect from the git remote URL.
 *   3. For glob/file inputs, fall back to `"md"` when auto-detection fails.
 *   4. For issue-number inputs, return `null` when auto-detection fails (caller should abort).
 */
export async function resolveSource(
  issues: string | string[],
  issueSource: DatasourceName | undefined,
  cwd: string
): Promise<DatasourceName | null> {
  if (issueSource) {
    return issueSource;
  }
  log.info("Detecting datasource from git remote...");
  const detected = await detectDatasource(cwd);
  if (detected) {
    log.info(`Detected datasource: ${detected}`);
    return detected;
  }
  if (!isIssueNumbers(issues)) {
    return "md";
  }
  log.error(
    `Could not detect datasource from the repository remote URL.\n` +
    `  Supported sources: ${DATASOURCE_NAMES.join(", ")}\n` +
    `  Use --source <name> to specify explicitly, or ensure the git remote\n` +
    `  points to a supported platform (github.com, dev.azure.com).`
  );
  return null;
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
  /** Issue numbers created or updated during spec generation (empty when datasource is md) */
  issueNumbers: string[];
  /** Dispatch identifiers for the "Run these specs with" hint (issue numbers or file paths) */
  identifiers?: string[];
  /** Total pipeline wall-clock duration in milliseconds */
  durationMs: number;
  /** Per-file generation durations in milliseconds (filepath → ms) */
  fileDurationsMs: Record<string, number>;
}

