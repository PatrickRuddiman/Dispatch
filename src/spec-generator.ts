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

import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem } from "node:os";
import type { IssueDetails, IssueFetchOptions, DatasourceName } from "./datasource.js";
import { boot as bootSpecAgent } from "./agents/spec.js";
import { getDatasource, detectDatasource, DATASOURCE_NAMES } from "./datasources/index.js";
import { extractTitle } from "./datasources/md.js";
import type { ProviderName } from "./provider.js";
import { bootProvider } from "./providers/index.js";
import { log } from "./logger.js";
import { elapsed } from "./format.js";
import { registerCleanup } from "./cleanup.js";
import { glob } from "glob";

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
  /** Total pipeline wall-clock duration in milliseconds */
  durationMs: number;
  /** Per-file generation durations in milliseconds (filepath → ms) */
  fileDurationsMs: Record<string, number>;
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

  const pipelineStart = Date.now();

  // ── Resolve datasource ─────────────────────────────────────
  const source = await resolveSource(issues, opts.issueSource, cwd);
  if (!source) {
    return { total: 0, generated: 0, failed: 0, files: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  const datasource = getDatasource(source);
  const fetchOpts: IssueFetchOptions = { cwd, org, project };

  // ── Determine items to process ─────────────────────────────
  const isTrackerMode = isIssueNumbers(issues);
  let items: { id: string; details: IssueDetails | null; error?: string }[];

  if (isTrackerMode) {
    // Issue-tracker mode: parse issue numbers and fetch via datasource
    const issueNumbers = issues
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (issueNumbers.length === 0) {
      log.error("No issue numbers provided. Use --spec 1,2,3");
      return { total: 0, generated: 0, failed: 0, files: [], durationMs: 0, fileDurationsMs: {} };
    }

    const fetchStart = Date.now();
    log.info(`Fetching ${issueNumbers.length} issue(s) from ${source} (concurrency: ${concurrency})...`);

    items = [];
    const fetchQueue = [...issueNumbers];

    while (fetchQueue.length > 0) {
      const batch = fetchQueue.splice(0, concurrency);
      log.debug(`Fetching batch of ${batch.length}: #${batch.join(", #")}`);
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          try {
            const details = await datasource.fetch(id, fetchOpts);
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
      items.push(...batchResults);
    }
    log.debug(`Issue fetching completed in ${elapsed(Date.now() - fetchStart)}`);
  } else {
    // File/glob mode: resolve files and build IssueDetails from content
    const files = await glob(issues, { cwd, absolute: true });

    if (files.length === 0) {
      log.error(`No files matched the pattern "${Array.isArray(issues) ? issues.join(", ") : issues}".`);
      return { total: 0, generated: 0, failed: 0, files: [], durationMs: 0, fileDurationsMs: {} };
    }

    log.info(`Matched ${files.length} file(s) for spec generation (concurrency: ${concurrency})...`);

    items = [];
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const title = extractTitle(content, filePath);
        const details: IssueDetails = {
          number: filePath,
          title,
          body: content,
          labels: [],
          state: "open",
          url: filePath,
          comments: [],
          acceptanceCriteria: "",
        };
        items.push({ id: filePath, details });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        items.push({ id: filePath, details: null, error: message });
      }
    }
  }

  const validItems = items.filter((i) => i.details !== null);
  if (validItems.length === 0) {
    const noun = isTrackerMode ? "issues" : "files";
    log.error(`No ${noun} could be loaded. Aborting spec generation.`);
    return { total: items.length, generated: 0, failed: items.length, files: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  // ── Boot AI provider ────────────────────────────────────────
  const bootStart = Date.now();
  log.info(`Booting ${provider} provider...`);
  log.debug(serverUrl ? `Using server URL: ${serverUrl}` : "No --server-url, will spawn local server");
  const instance = await bootProvider(provider, { url: serverUrl, cwd });
  registerCleanup(() => instance.cleanup());
  log.debug(`Provider booted in ${elapsed(Date.now() - bootStart)}`);

  // ── Boot spec agent ─────────────────────────────────────────
  const specAgent = await bootSpecAgent({ provider: instance, cwd });

  // ── Generate spec for each item (parallel batches) ──────────
  await mkdir(outputDir, { recursive: true });

  const generatedFiles: string[] = [];
  let failed = items.filter((i) => i.details === null).length;
  const fileDurationsMs: Record<string, number> = {};

  const genQueue = [...validItems];

  while (genQueue.length > 0) {
    const batch = genQueue.splice(0, concurrency);
    log.info(`Generating specs for batch of ${batch.length} (${generatedFiles.length + failed}/${items.length} done)...`);

    const batchResults = await Promise.all(
      batch.map(async ({ id, details }) => {
        const specStart = Date.now();

        // Determine the spec output filepath
        let filepath: string;
        if (isTrackerMode) {
          // Issue-tracker: write to outputDir with slug filename
          const slug = details!.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60);
          const filename = `${id}-${slug}.md`;
          filepath = join(outputDir, filename);
        } else {
          // File-based: overwrite the source file in-place
          filepath = id;
        }

        try {
          log.info(`Generating spec for ${isTrackerMode ? `#${id}` : filepath}: ${details!.title}...`);

          const result = await specAgent.generate({
            issue: isTrackerMode ? details! : undefined,
            filePath: isTrackerMode ? undefined : id,
            fileContent: isTrackerMode ? undefined : details!.body,
            cwd,
            outputPath: filepath,
          });

          if (!result.success) {
            throw new Error(result.error ?? "Spec generation failed");
          }

          const specDuration = Date.now() - specStart;
          fileDurationsMs[filepath] = specDuration;
          log.success(`Spec written: ${filepath} (${elapsed(specDuration)})`);

          // Push spec content back to the datasource
          try {
            if (isTrackerMode) {
              // Tracker mode: update the existing issue with the generated spec
              await datasource.update(id, details!.title, result.content, fetchOpts);
              log.success(`Updated issue #${id} with spec content`);
            } else if (datasource.name !== "md") {
              // File/glob mode with tracker datasource: create a new issue and delete the local file
              const created = await datasource.create(details!.title, result.content, fetchOpts);
              log.success(`Created issue #${created.number} from ${filepath}`);
              await unlink(filepath);
              log.success(`Deleted local spec ${filepath} (now tracked as issue #${created.number})`);
            }
            // md datasource + file/glob mode: file already written in-place, nothing to do
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const label = isTrackerMode ? `issue #${id}` : filepath;
            log.warn(`Could not sync ${label} to datasource: ${message}`);
          }

          return filepath;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Failed to generate spec for ${isTrackerMode ? `#${id}` : filepath}: ${message}`);
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
  await specAgent.cleanup();
  await instance.cleanup();

  const totalDuration = Date.now() - pipelineStart;
  log.info(
    `Spec generation complete: ${generatedFiles.length} generated, ${failed} failed in ${elapsed(totalDuration)}`
  );

  if (generatedFiles.length > 0) {
    log.dim(`\n  Run these specs with:`);
    if (isTrackerMode) {
      log.dim(`    dispatch "${outputDir}/*.md"\n`);
    } else {
      log.dim(`    dispatch ${generatedFiles.map((f) => '"' + f + '"').join(" ")}\n`);
    }
  }

  return {
    total: items.length,
    generated: generatedFiles.length,
    failed,
    files: generatedFiles,
    durationMs: totalDuration,
    fileDurationsMs,
  };
}

