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
import type { IssueDetails, IssueFetchOptions, Datasource, DatasourceName } from "../datasources/interface.js";
import { getDatasource } from "../datasources/index.js";
import { extractTitle } from "../datasources/md.js";
import type { ProviderInstance, ProviderName } from "../providers/interface.js";
import { bootProvider } from "../providers/index.js";
import type { SpecAgent } from "../agents/spec.js";
import { boot as bootSpecAgent } from "../agents/spec.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { log } from "../helpers/logger.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import chalk from "chalk";
import { elapsed, renderHeaderLines } from "../helpers/format.js";
import { withRetry } from "../helpers/retry.js";
import { slugify, MAX_SLUG_LENGTH } from "../helpers/slugify.js";

// ── Shared types for pipeline stages ──────────────────────────

/** An item resolved from any input mode (tracker, file, or inline text). */
interface ResolvedItem {
  id: string;
  details: IssueDetails | null;
  error?: string;
}

/** A successfully resolved item with non-null details. */
interface ValidItem {
  id: string;
  details: IssueDetails;
  error?: string;
}

/** Result of the datasource resolution stage. */
interface ResolvedSource {
  source: DatasourceName;
  datasource: Datasource;
  fetchOpts: IssueFetchOptions;
}

/** Accumulated state from the batch generation loop. */
interface GenerationResults {
  generatedFiles: string[];
  issueNumbers: string[];
  dispatchIdentifiers: string[];
  failed: number;
  fileDurationsMs: Record<string, number>;
}

// ── Pipeline stage functions ──────────────────────────────────

/**
 * Resolve the datasource from options.
 * Returns null when resolution fails (caller should return early).
 */
async function resolveDatasource(
  issues: string | string[],
  issueSource: DatasourceName | undefined,
  specCwd: string,
  org?: string,
  project?: string,
  workItemType?: string,
): Promise<ResolvedSource | null> {
  const source = await resolveSource(issues, issueSource, specCwd);
  if (!source) return null;

  const datasource = getDatasource(source);
  const fetchOpts: IssueFetchOptions = { cwd: specCwd, org, project, workItemType };
  return { source, datasource, fetchOpts };
}

/**
 * Fetch items from an issue tracker by number.
 * Returns an empty array if no issue numbers were provided.
 */
async function fetchTrackerItems(
  issues: string,
  datasource: Datasource,
  fetchOpts: IssueFetchOptions,
  concurrency: number,
  source: DatasourceName,
): Promise<ResolvedItem[]> {
  const issueNumbers = issues
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (issueNumbers.length === 0) {
    log.error("No issue numbers provided. Use --spec 1,2,3");
    return [];
  }

  const fetchStart = Date.now();
  log.info(`Fetching ${issueNumbers.length} issue(s) from ${source} (concurrency: ${concurrency})...`);

  const items: ResolvedItem[] = [];
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
          const message = log.extractMessage(err);
          log.error(`Failed to fetch #${id}: ${log.formatErrorChain(err)}`);
          log.debug(log.formatErrorChain(err));
          return { id, details: null, error: message };
        }
      })
    );
    items.push(...batchResults);
  }
  log.debug(`Issue fetching completed in ${elapsed(Date.now() - fetchStart)}`);
  return items;
}

/** Construct a single item from inline text input. */
function buildInlineTextItem(
  issues: string | string[],
  outputDir: string,
): ResolvedItem[] {
  const text = Array.isArray(issues) ? issues.join(" ") : issues;
  const title = text.length > 80 ? text.slice(0, 80).trimEnd() + "…" : text;
  const slug = slugify(text, MAX_SLUG_LENGTH);
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
  return [{ id: filepath, details }];
}

/** Resolve items from a glob pattern or file paths. */
async function resolveFileItems(
  issues: string | string[],
  specCwd: string,
  concurrency: number,
): Promise<ResolvedItem[] | null> {
  const files = await glob(issues, { cwd: specCwd, absolute: true });

  if (files.length === 0) {
    log.error(`No files matched the pattern "${Array.isArray(issues) ? issues.join(", ") : issues}".`);
    return null;
  }

  log.info(`Matched ${files.length} file(s) for spec generation (concurrency: ${concurrency})...`);

  const items: ResolvedItem[] = [];
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
      items.push({ id: filePath, details: null, error: log.extractMessage(err) });
    }
  }
  return items;
}

/** Filter items to those with non-null details. */
function filterValidItems(
  items: ResolvedItem[],
  isTrackerMode: boolean,
  isInlineText: boolean,
): ValidItem[] | null {
  const validItems = items.filter(
    (i): i is ValidItem => i.details !== null,
  );
  if (validItems.length === 0) {
    const noun = isTrackerMode ? "issues" : isInlineText ? "inline specs" : "files";
    log.error(`No ${noun} could be loaded. Aborting spec generation.`);
    return null;
  }
  return validItems;
}

/** Log a dry-run preview of what would be generated. */
function previewDryRun(
  validItems: ValidItem[],
  items: ResolvedItem[],
  isTrackerMode: boolean,
  isInlineText: boolean,
  outputDir: string,
  pipelineStart: number,
): SpecSummary {
  const mode = isTrackerMode ? "tracker" : isInlineText ? "inline" : "file";
  log.info(`[DRY RUN] Would generate ${validItems.length} spec(s) (mode: ${mode}):\n`);

  for (const { id, details } of validItems) {
    let filepath: string;
    if (isTrackerMode) {
      const slug = slugify(details.title, 60);
      filepath = join(outputDir, `${id}-${slug}.md`);
    } else {
      filepath = id;
    }

    const label = isTrackerMode ? `#${id}` : filepath;
    log.info(`[DRY RUN] Would generate spec for ${label}: "${details.title}"`);
    log.dim(`    → ${filepath}`);
  }

  return {
    total: items.length,
    generated: 0,
    failed: items.filter((i) => i.details === null).length,
    files: [],
    issueNumbers: [],
    durationMs: Date.now() - pipelineStart,
    fileDurationsMs: {},
  };
}

/** Boot the AI provider and spec agent, render the header banner. */
async function bootPipeline(
  provider: ProviderName,
  serverUrl: string | undefined,
  specCwd: string,
  model: string | undefined,
  source: DatasourceName,
): Promise<{ specAgent: SpecAgent; instance: ProviderInstance }> {
  const bootStart = Date.now();
  log.info(`Booting ${provider} provider...`);
  log.debug(serverUrl ? `Using server URL: ${serverUrl}` : "No --server-url, will spawn local server");
  const instance = await bootProvider(provider, { url: serverUrl, cwd: specCwd, model });
  registerCleanup(() => instance.cleanup());
  log.debug(`Provider booted in ${elapsed(Date.now() - bootStart)}`);

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

  const specAgent = await bootSpecAgent({ provider: instance, cwd: specCwd });

  return { specAgent, instance };
}

/** Generate specs in parallel batches, sync to datasource, and track results. */
async function generateSpecsBatch(
  validItems: ValidItem[],
  items: ResolvedItem[],
  specAgent: SpecAgent,
  instance: ProviderInstance,
  isTrackerMode: boolean,
  isInlineText: boolean,
  datasource: Datasource,
  fetchOpts: IssueFetchOptions,
  outputDir: string,
  specCwd: string,
  concurrency: number,
  retries: number,
): Promise<GenerationResults> {
  await mkdir(outputDir, { recursive: true });

  const generatedFiles: string[] = [];
  const issueNumbers: string[] = [];
  const dispatchIdentifiers: string[] = [];
  let failed = items.filter((i) => i.details === null).length;
  const fileDurationsMs: Record<string, number> = {};

  const genQueue = [...validItems];
  let modelLoggedInBanner = !!instance.model;

  while (genQueue.length > 0) {
    const batch = genQueue.splice(0, concurrency);
    log.info(`Generating specs for batch of ${batch.length} (${generatedFiles.length + failed}/${items.length} done)...`);

    const batchResults = await Promise.all(
      batch.map(async ({ id, details }) => {
        const specStart = Date.now();

        if (!details) {
          log.error(`Skipping item ${id}: missing issue details`);
          return null;
        }

        let filepath: string;
        if (isTrackerMode) {
          const slug = slugify(details.title, MAX_SLUG_LENGTH);
          const filename = `${id}-${slug}.md`;
          filepath = join(outputDir, filename);
        } else if (isInlineText) {
          filepath = id;
        } else {
          filepath = id;
        }

        try {
          log.info(`Generating spec for ${isTrackerMode ? `#${id}` : filepath}: ${details.title}...`);

          const result = await withRetry(
            () => specAgent.generate({
              issue: isTrackerMode ? details : undefined,
              filePath: isTrackerMode ? undefined : id,
              fileContent: isTrackerMode ? undefined : details.body,
              cwd: specCwd,
              outputPath: filepath,
            }),
            retries,
            { label: `specAgent.generate(${isTrackerMode ? `#${id}` : filepath})` },
          );

          if (!result.success) {
            throw new Error(result.error ?? "Spec generation failed");
          }

          if (!result.data) {
            throw new Error("Spec generation succeeded but returned no data");
          }

          if (isTrackerMode || isInlineText) {
            const h1Title = extractTitle(result.data.content, filepath);
            const h1Slug = slugify(h1Title, MAX_SLUG_LENGTH);
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

          let identifier = filepath;

          try {
            if (isTrackerMode) {
              await datasource.update(id, details.title, result.data.content, fetchOpts);
              log.success(`Updated issue #${id} with spec content`);
              await unlink(filepath);
              log.success(`Deleted local spec ${filepath} (now tracked as issue #${id})`);
              identifier = id;
              issueNumbers.push(id);
            } else if (datasource.name !== "md") {
              const created = await datasource.create(details.title, result.data.content, fetchOpts);
              log.success(`Created issue #${created.number} from ${filepath}`);
              await unlink(filepath);
              log.success(`Deleted local spec ${filepath} (now tracked as issue #${created.number})`);
              identifier = created.number;
              issueNumbers.push(created.number);
            }
          } catch (err) {
            const label = isTrackerMode ? `issue #${id}` : filepath;
            log.warn(`Could not sync ${label} to datasource: ${log.formatErrorChain(err)}`);
          }

          return { filepath, identifier };
        } catch (err) {
          log.error(`Failed to generate spec for ${isTrackerMode ? `#${id}` : filepath}: ${log.formatErrorChain(err)}`);
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

    if (!modelLoggedInBanner && instance.model) {
      log.info(`Detected model: ${instance.model}`);
      modelLoggedInBanner = true;
    }
  }

  return { generatedFiles, issueNumbers, dispatchIdentifiers, failed, fileDurationsMs };
}

/** Clean up spec agent and provider, logging warnings on failure. */
async function cleanupPipeline(
  specAgent: SpecAgent,
  instance: ProviderInstance,
): Promise<void> {
  try {
    await specAgent.cleanup();
  } catch (err) {
    log.warn(`Spec agent cleanup failed: ${log.formatErrorChain(err)}`);
  }
  try {
    await instance.cleanup();
  } catch (err) {
    log.warn(`Provider cleanup failed: ${log.formatErrorChain(err)}`);
  }
}

/** Log the final summary and dispatch hint. */
function logSummary(
  generatedFiles: string[],
  dispatchIdentifiers: string[],
  failed: number,
  totalDuration: number,
): void {
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
}

// ── Public API ────────────────────────────────────────────────

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
    dryRun,
    retries = 2,
  } = opts;

  const pipelineStart = Date.now();

  // ── Resolve datasource ─────────────────────────────────────
  const resolved = await resolveDatasource(issues, opts.issueSource, specCwd, org, project, workItemType);
  if (!resolved) {
    return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }
  const { source, datasource, fetchOpts } = resolved;

  // ── Determine items to process ─────────────────────────────
  const isTrackerMode = isIssueNumbers(issues);
  const isInlineText = !isTrackerMode && !isGlobOrFilePath(issues);
  let items: ResolvedItem[];

  if (isTrackerMode) {
    items = await fetchTrackerItems(issues, datasource, fetchOpts, concurrency, source);
    if (items.length === 0) {
      return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
    }
  } else if (isInlineText) {
    items = buildInlineTextItem(issues, outputDir);
  } else {
    const fileItems = await resolveFileItems(issues, specCwd, concurrency);
    if (!fileItems) {
      return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
    }
    items = fileItems;
  }

  // ── Filter valid items ─────────────────────────────────────
  const validItems = filterValidItems(items, isTrackerMode, isInlineText);
  if (!validItems) {
    return { total: items.length, generated: 0, failed: items.length, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  // ── Dry-run preview ────────────────────────────────────────
  if (dryRun) {
    return previewDryRun(validItems, items, isTrackerMode, isInlineText, outputDir, pipelineStart);
  }

  // ── Confirm large batch ────────────────────────────────────
  const confirmed = await confirmLargeBatch(validItems.length);
  if (!confirmed) {
    return { total: 0, generated: 0, failed: 0, files: [], issueNumbers: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
  }

  // ── Boot provider and spec agent ───────────────────────────
  const { specAgent, instance } = await bootPipeline(provider, serverUrl, specCwd, model, source);

  // ── Generate specs in batches ──────────────────────────────
  const results = await generateSpecsBatch(
    validItems, items, specAgent, instance,
    isTrackerMode, isInlineText,
    datasource, fetchOpts, outputDir, specCwd,
    concurrency, retries,
  );

  // ── Cleanup ────────────────────────────────────────────────
  await cleanupPipeline(specAgent, instance);

  // ── Summary ────────────────────────────────────────────────
  const totalDuration = Date.now() - pipelineStart;
  logSummary(results.generatedFiles, results.dispatchIdentifiers, results.failed, totalDuration);

  return {
    total: items.length,
    generated: results.generatedFiles.length,
    failed: results.failed,
    files: results.generatedFiles,
    issueNumbers: results.issueNumbers,
    identifiers: results.dispatchIdentifiers,
    durationMs: totalDuration,
    fileDurationsMs: results.fileDurationsMs,
  };
}
