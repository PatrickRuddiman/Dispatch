/**
 * Spec generation pipeline — extracted from the orchestrator to keep the
 * coordinator thin and this pipeline independently testable.
 *
 * Handles: datasource resolution, issue fetching (tracker and file/glob
 * modes), provider/agent booting, batch spec generation, datasource sync
 * (update existing issues or create new ones), and cleanup.
 */

import { join } from "node:path";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { glob } from "glob";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { isIssueNumbers, isGlobOrFilePath, resolveSource, defaultConcurrency } from "../spec-generator.js";
import type { IssueDetails, IssueFetchOptions } from "../datasources/interface.js";
import { getDatasource } from "../datasources/index.js";
import { extractTitle } from "../datasources/md.js";
import { bootProvider } from "../providers/index.js";
import { boot as bootSpecAgent } from "../agents/spec.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { log } from "../helpers/logger.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import chalk from "chalk";
import { elapsed, renderHeaderLines } from "../helpers/format.js";
import { slugify } from "../helpers/slugify.js";

/**
 * Run the spec-generation pipeline end-to-end.
 *
 * This is the extracted core of the orchestrator's `generateSpecs()` method.
 * It accepts `SpecOptions` and returns a `SpecSummary`.
 */
export async function runSpecPipeline(opts: SpecOptions): Promise<SpecSummary> {
  const {
    issues,
    provider,
    model,
    serverUrl,
    cwd: specCwd,
    outputDir = join(specCwd, ".dispatch", "specs"),
    org,
    project,
    workItemType,
    concurrency = defaultConcurrency(),
  } = opts;

  const pipelineStart = Date.now();

  // ── Resolve datasource ─────────────────────────────────────
  const source = await resolveSource(issues, opts.issueSource, specCwd);
  if (!source) {
    return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  const datasource = getDatasource(source);
  const fetchOpts: IssueFetchOptions = { cwd: specCwd, org, project, workItemType };

  // ── Determine items to process ─────────────────────────────
  const isTrackerMode = isIssueNumbers(issues);
  const isInlineText = !isTrackerMode && !isGlobOrFilePath(issues);
  let items: { id: string; details: IssueDetails | null; error?: string }[];

  if (isTrackerMode) {
    // Issue-tracker mode: parse issue numbers and fetch via datasource
    const issueNumbers = issues
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (issueNumbers.length === 0) {
      log.error("No issue numbers provided. Use --spec 1,2,3");
      return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: 0, fileDurationsMs: {} };
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
  } else if (isInlineText) {
    // Inline text mode: construct IssueDetails from the raw text
    const text = Array.isArray(issues) ? issues.join(" ") : issues;
    const title = text.length > 80 ? text.slice(0, 80).trimEnd() + "…" : text;
    const slug = slugify(text, 60);
    const filename = `${slug}.md`;
    const filepath = join(outputDir, filename);

    const details: IssueDetails = {
      number: filepath,
      title,
      body: text,
      labels: [],
      state: "open",
      url: filepath,
      comments: [],
      acceptanceCriteria: "",
    };

    log.info(`Inline text spec: "${title}"`);
    items = [{ id: filepath, details }];
  } else {
    // File/glob mode: resolve files and build IssueDetails from content
    const files = await glob(issues, { cwd: specCwd, absolute: true });

    if (files.length === 0) {
      log.error(`No files matched the pattern "${Array.isArray(issues) ? issues.join(", ") : issues}".`);
      return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: 0, fileDurationsMs: {} };
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
    const noun = isTrackerMode ? "issues" : isInlineText ? "inline specs" : "files";
    log.error(`No ${noun} could be loaded. Aborting spec generation.`);
    return { total: items.length, generated: 0, failed: items.length, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  // ── Confirm large batch ─────────────────────────────────────
  const confirmed = await confirmLargeBatch(validItems.length);
  if (!confirmed) {
    return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  // ── Boot AI provider ────────────────────────────────────────
  const bootStart = Date.now();
  log.info(`Booting ${provider} provider...`);
  log.debug(serverUrl ? `Using server URL: ${serverUrl}` : "No --server-url, will spawn local server");
  const instance = await bootProvider(provider, { url: serverUrl, cwd: specCwd, model });
  registerCleanup(() => instance.cleanup());
  log.debug(`Provider booted in ${elapsed(Date.now() - bootStart)}`);

  // ── Header banner ────────────────────────────────────────────
  const headerLines = renderHeaderLines({
    provider,
    model: instance.model,
    source,
  });
  console.log("");
  for (const line of headerLines) {
    console.log(line);
  }
  console.log(chalk.dim("  ─".repeat(24)));
  console.log("");

  // ── Boot spec agent ─────────────────────────────────────────
  const specAgent = await bootSpecAgent({ provider: instance, cwd: specCwd });

  // ── Generate spec for each item (parallel batches) ──────────
  await mkdir(outputDir, { recursive: true });

  const generatedFiles: string[] = [];
  const issueNumbers: string[] = [];
  const dispatchIdentifiers: string[] = [];
  let failed = items.filter((i) => i.details === null).length;
  const fileDurationsMs: Record<string, number> = {};

  const genQueue = [...validItems];
  let modelLoggedInBanner = !!instance.model; // true if model was already shown in header

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
          const slug = slugify(details!.title, 60);
          const filename = `${id}-${slug}.md`;
          filepath = join(outputDir, filename);
        } else if (isInlineText) {
          // Inline text: id is already the full output path
          filepath = id;
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
            cwd: specCwd,
            outputPath: filepath,
          });

          if (!result.success) {
            throw new Error(result.error ?? "Spec generation failed");
          }

          // Derive final filename from H1 heading in the generated spec
          if (isTrackerMode || isInlineText) {
            const h1Title = extractTitle(result.content, filepath);
            const h1Slug = slugify(h1Title, 60);
            const finalFilename = isTrackerMode ? `${id}-${h1Slug}.md` : `${h1Slug}.md`;
            const finalFilepath = join(outputDir, finalFilename);
            if (finalFilepath !== filepath) {
              await rename(filepath, finalFilepath);
              filepath = finalFilepath;
            }
          }

          const specDuration = Date.now() - specStart;
          fileDurationsMs[filepath] = specDuration;
          log.success(`Spec written: ${filepath} (${elapsed(specDuration)})`);

          // Determine the dispatch identifier for "Run these specs with" output
          let identifier = filepath; // default: local file path (md datasource)

          // Push spec content back to the datasource
          try {
            if (isTrackerMode) {
              // Tracker mode: update the existing issue with the generated spec
              await datasource.update(id, details!.title, result.content, fetchOpts);
              log.success(`Updated issue #${id} with spec content`);
              identifier = id;
              issueNumbers.push(id);
            } else if (datasource.name !== "md") {
              // File/glob mode with tracker datasource: create a new issue and delete the local file
              const created = await datasource.create(details!.title, result.content, fetchOpts);
              log.success(`Created issue #${created.number} from ${filepath}`);
              await unlink(filepath);
              log.success(`Deleted local spec ${filepath} (now tracked as issue #${created.number})`);
              identifier = created.number;
              issueNumbers.push(created.number);
            }
            // md datasource + file/glob mode: file already written in-place, nothing to do
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const label = isTrackerMode ? `issue #${id}` : filepath;
            log.warn(`Could not sync ${label} to datasource: ${message}`);
          }

          return { filepath, identifier };
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
        generatedFiles.push(result.filepath);
        dispatchIdentifiers.push(result.identifier);
      } else {
        failed++;
      }
    }

    // Log model once detected (wasn't available at header time for lazy providers)
    if (!modelLoggedInBanner && instance.model) {
      log.info(`Detected model: ${instance.model}`);
      modelLoggedInBanner = true;
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
    const allNumeric = dispatchIdentifiers.every((id) => /^\d+$/.test(id));
    if (allNumeric) {
      log.dim(`    dispatch ${dispatchIdentifiers.join(",")}\n`);
    } else {
      log.dim(`    dispatch ${dispatchIdentifiers.map((f) => '"' + f + '"').join(" ")}\n`);
    }
  }

  return {
    total: items.length,
    generated: generatedFiles.length,
    failed,
    files: generatedFiles,
    issueNumbers,
    identifiers: dispatchIdentifiers,
    durationMs: totalDuration,
    fileDurationsMs,
  };
}
