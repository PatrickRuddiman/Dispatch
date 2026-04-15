/**
 * Child process entry point for dispatch/spec pipelines.
 *
 * Receives configuration via IPC, runs the appropriate pipeline,
 * and sends progress events back to the parent via process.send().
 */

import { boot as bootOrchestrator } from "../orchestrator/runner.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";

interface StartDispatchMessage {
  type: "dispatch";
  cwd: string;
  opts: Record<string, unknown>;
}

interface StartSpecMessage {
  type: "spec";
  cwd: string;
  opts: Record<string, unknown>;
}

type WorkerMessage = StartDispatchMessage | StartSpecMessage;

process.on("message", (msg: WorkerMessage) => {
  void handleMessage(msg);
});

/** Send an IPC message and wait for it to flush before continuing. */
function sendAndFlush(msg: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.send!(msg, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function handleMessage(msg: WorkerMessage): Promise<void> {
  try {
    if (msg.type === "dispatch") {
      const orchestrator = await bootOrchestrator({ cwd: msg.cwd });
      const result = await orchestrator.orchestrate({
        ...msg.opts,
        progressCallback: (event: Record<string, unknown>) => {
          process.send!({ type: "progress", event });
        },
      } as never);
      await sendAndFlush({ type: "done", result });
    } else if (msg.type === "spec") {
      const result = await runSpecPipeline({
        ...msg.opts,
        progressCallback: (event: Record<string, unknown>) => {
          process.send!({ type: "spec_progress", event });
        },
      } as never);
      await sendAndFlush({ type: "done", result });
    }
  } catch (err) {
    await sendAndFlush({ type: "error", message: err instanceof Error ? err.message : String(err) }).catch(() => {});
  }
  process.exit(0);
}
