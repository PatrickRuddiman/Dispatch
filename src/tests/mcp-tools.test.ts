/**
 * Tests for MCP tool registration functions.
 *
 * These tests verify the tool handler logic by:
 * 1. Using a mock McpServer that captures registered tools
 * 2. Calling the captured tool handlers directly
 * 3. Mocking all external dependencies (manager, pipelines, fs)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockCreateRun, mockFinishRun, mockUpdateRunCounters, mockCreateTask,
  mockUpdateTaskStatus, mockEmitLog, mockCreateSpecRun, mockFinishSpecRun,
  mockListSpecRuns, mockGetSpecRun, mockGetRun, mockListRuns, mockGetTasksForRun,
  mockListRunsByStatus,
} = vi.hoisted(() => ({
  mockCreateRun: vi.fn().mockReturnValue("test-run-id"),
  mockFinishRun: vi.fn(),
  mockUpdateRunCounters: vi.fn(),
  mockCreateTask: vi.fn(),
  mockUpdateTaskStatus: vi.fn(),
  mockEmitLog: vi.fn(),
  mockCreateSpecRun: vi.fn().mockReturnValue("test-spec-run-id"),
  mockFinishSpecRun: vi.fn(),
  mockListSpecRuns: vi.fn().mockReturnValue([]),
  mockGetSpecRun: vi.fn().mockReturnValue(null),
  mockGetRun: vi.fn().mockReturnValue(null),
  mockListRuns: vi.fn().mockReturnValue([]),
  mockGetTasksForRun: vi.fn().mockReturnValue([]),
  mockListRunsByStatus: vi.fn().mockReturnValue([]),
}));

const { mockBootOrchestrator, mockOrchestrate } = vi.hoisted(() => {
  const mockOrchestrate = vi.fn().mockResolvedValue({ total: 1, completed: 1, failed: 0 });
  const mockBootOrchestrator = vi.fn().mockResolvedValue({ orchestrate: mockOrchestrate });
  return { mockBootOrchestrator, mockOrchestrate };
});

const { mockRunSpecPipeline } = vi.hoisted(() => ({
  mockRunSpecPipeline: vi.fn().mockResolvedValue({ total: 1, generated: 1, failed: 0 }),
}));

const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn().mockResolvedValue({
    source: "github",
    provider: "opencode",
    concurrency: 1,
  }),
}));

const { mockGetDatasource } = vi.hoisted(() => ({
  mockGetDatasource: vi.fn().mockReturnValue({
    list: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockResolvedValue({ number: "1", title: "Test", body: "", labels: [], url: "", state: "open", comments: [], acceptanceCriteria: "" }),
  }),
}));

const { mockReaddir, mockReadFile } = vi.hoisted(() => ({
  mockReaddir: vi.fn().mockResolvedValue([]),
  mockReadFile: vi.fn().mockResolvedValue("spec content"),
}));

// ─── Module mocks ────────────────────────────────────────────

vi.mock("../mcp/state/manager.js", () => ({
  createRun: mockCreateRun,
  finishRun: mockFinishRun,
  updateRunCounters: mockUpdateRunCounters,
  createTask: mockCreateTask,
  updateTaskStatus: mockUpdateTaskStatus,
  emitLog: mockEmitLog,
  createSpecRun: mockCreateSpecRun,
  finishSpecRun: mockFinishSpecRun,
  listSpecRuns: mockListSpecRuns,
  getSpecRun: mockGetSpecRun,
  getRun: mockGetRun,
  listRuns: mockListRuns,
  getTasksForRun: mockGetTasksForRun,
  listRunsByStatus: mockListRunsByStatus,
  registerLiveRun: vi.fn(),
  unregisterLiveRun: vi.fn(),
  addLogCallback: vi.fn(),
}));

vi.mock("../orchestrator/runner.js", () => ({
  boot: mockBootOrchestrator,
}));

vi.mock("../orchestrator/spec-pipeline.js", () => ({
  runSpecPipeline: mockRunSpecPipeline,
}));

vi.mock("../config.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../datasources/index.js", () => ({
  getDatasource: mockGetDatasource,
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

// ─── Imports (after mocks) ───────────────────────────────────

import { registerDispatchTools } from "../mcp/tools/dispatch.js";
import { registerSpecTools } from "../mcp/tools/spec.js";
import { registerMonitorTools } from "../mcp/tools/monitor.js";
import { registerRecoveryTools } from "../mcp/tools/recovery.js";
import { registerConfigTools } from "../mcp/tools/config.js";

// ─── Mock McpServer ──────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    }),
    getHandler(name: string): ToolHandler {
      const h = tools.get(name);
      if (!h) throw new Error(`Tool ${name} not registered`);
      return h;
    },
  };
}

// ─── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockReturnValue("test-run-id");
  mockCreateSpecRun.mockReturnValue("test-spec-run-id");
  mockOrchestrate.mockResolvedValue({ total: 1, completed: 1, failed: 0 });
  mockRunSpecPipeline.mockResolvedValue({ total: 1, generated: 1, failed: 0 });
  mockLoadConfig.mockResolvedValue({ source: "github", provider: "opencode", concurrency: 1 });
  mockGetDatasource.mockReturnValue({
    list: vi.fn().mockResolvedValue([
      { number: "1", title: "Issue 1", state: "open", labels: [], url: "http://example.com/1" },
    ]),
    fetch: vi.fn().mockResolvedValue({ number: "1", title: "Test", body: "", labels: [], url: "", state: "open", comments: [], acceptanceCriteria: "" }),
  });
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockResolvedValue("spec content");
  mockGetRun.mockReturnValue(null);
  mockListRuns.mockReturnValue([]);
  mockGetTasksForRun.mockReturnValue([]);
  mockListRunsByStatus.mockReturnValue([]);
  mockListSpecRuns.mockReturnValue([]);
  mockGetSpecRun.mockReturnValue(null);
});

// ─── dispatch tools ──────────────────────────────────────────

describe("registerDispatchTools", () => {
  it("registers dispatch_run and dispatch_dry_run tools", () => {
    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    expect(server.tool).toHaveBeenCalledWith("dispatch_run", expect.any(String), expect.any(Object), expect.any(Function));
    expect(server.tool).toHaveBeenCalledWith("dispatch_dry_run", expect.any(String), expect.any(Object), expect.any(Function));
  });

  it("dispatch_run creates a run and returns runId immediately", async () => {
    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    const result = await server.getHandler("dispatch_run")({ issueIds: ["42"] });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.runId).toBe("test-run-id");
    expect(data.status).toBe("running");
    expect(mockCreateRun).toHaveBeenCalledWith({ cwd: "/cwd", issueIds: ["42"] });
  });

  it("dispatch_dry_run calls orchestrate with dryRun:true and returns result", async () => {
    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    mockOrchestrate.mockResolvedValue({ total: 3, completed: 3, failed: 0, tasks: [] });
    const result = await server.getHandler("dispatch_dry_run")({ issueIds: ["5"] });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.total).toBe(3);
    expect(mockOrchestrate).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it("dispatch_dry_run returns isError on orchestrator exception", async () => {
    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    mockBootOrchestrator.mockRejectedValueOnce(new Error("boot failed"));
    const result = await server.getHandler("dispatch_dry_run")({ issueIds: ["5"] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("boot failed");
  });

  it("dispatch_run background: fires progress callbacks and finishes run on success", async () => {
    let capturedCallback: ((event: Record<string, unknown>) => void) | undefined;

    mockOrchestrate.mockImplementation(async (opts: { progressCallback?: (e: Record<string, unknown>) => void }) => {
      capturedCallback = opts.progressCallback;
      // Fire all event types
      opts.progressCallback?.({ type: "task_start", taskId: "t:1", taskText: "Do thing" });
      opts.progressCallback?.({ type: "task_done", taskId: "t:1", taskText: "Do thing" });
      opts.progressCallback?.({ type: "task_failed", taskId: "t:2", taskText: "Fail thing", error: "oops" });
      opts.progressCallback?.({ type: "phase_change", phase: "executing", message: "Now executing" });
      opts.progressCallback?.({ type: "phase_change", phase: "planning" }); // no message
      opts.progressCallback?.({ type: "log", message: "some log" });
      return { total: 2, completed: 1, failed: 1 };
    });

    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    await server.getHandler("dispatch_run")({ issueIds: ["42"] });

    // Flush the setImmediate
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("test-run-id", "t:1", "running");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("test-run-id", "t:1", "success");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("test-run-id", "t:2", "failed", { error: "oops" });
    expect(mockFinishRun).toHaveBeenCalledWith("test-run-id", "failed");
    expect(capturedCallback).toBeDefined();
  });

  it("dispatch_run background: finishes run as completed when all tasks succeed", async () => {
    mockOrchestrate.mockResolvedValue({ total: 1, completed: 1, failed: 0 });

    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    await server.getHandler("dispatch_run")({ issueIds: ["1"] });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockFinishRun).toHaveBeenCalledWith("test-run-id", "completed");
  });

  it("dispatch_run background: finishes run as failed on orchestrator error", async () => {
    mockBootOrchestrator.mockRejectedValueOnce(new Error("orchestrator crashed"));

    const server = createMockServer();
    registerDispatchTools(server as never, "/cwd");
    await server.getHandler("dispatch_run")({ issueIds: ["1"] });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockFinishRun).toHaveBeenCalledWith("test-run-id", "failed", "orchestrator crashed");
  });
});

// ─── spec tools ──────────────────────────────────────────────

describe("registerSpecTools", () => {
  it("registers spec_generate, spec_list, spec_read, spec_runs_list, spec_run_status", () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    const calls = server.tool.mock.calls.map(c => c[0]);
    expect(calls).toContain("spec_generate");
    expect(calls).toContain("spec_list");
    expect(calls).toContain("spec_read");
    expect(calls).toContain("spec_runs_list");
    expect(calls).toContain("spec_run_status");
  });

  it("spec_generate creates a spec run and returns runId immediately", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    const result = await server.getHandler("spec_generate")({ issues: "42" });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.runId).toBe("test-spec-run-id");
    expect(data.status).toBe("running");
  });

  it("spec_list returns empty list when no specs exist", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    const result = await server.getHandler("spec_list")({});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.files).toEqual([]);
  });

  it("spec_list returns .md files from the specs dir", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockReaddir.mockResolvedValue(["42-feature.md", "readme.txt", "43-fix.md"] as never);
    const result = await server.getHandler("spec_list")({});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.files).toEqual(["42-feature.md", "43-fix.md"]);
  });

  it("spec_read returns file content for a known file", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockReadFile.mockResolvedValue("# Spec content\n- [ ] Do thing\n" as never);
    const result = await server.getHandler("spec_read")({ file: "42-feature.md" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("Spec content");
  });

  it("spec_read returns isError for path traversal attempt", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    const result = await server.getHandler("spec_read")({ file: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Access denied");
  });

  it("spec_read returns isError when file does not exist", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    const notFound = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile.mockRejectedValueOnce(notFound);
    const result = await server.getHandler("spec_read")({ file: "missing.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("spec_read returns isError for non-ENOENT read errors", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockReadFile.mockRejectedValueOnce(new Error("permission denied"));
    const result = await server.getHandler("spec_read")({ file: "locked.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error reading");
  });

  it("spec_list includes recentRuns from database", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockListSpecRuns.mockReturnValue([{ runId: "sr-1", status: "completed" }]);
    const result = await server.getHandler("spec_list")({});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.recentRuns).toHaveLength(1);
    expect(data.recentRuns[0].runId).toBe("sr-1");
  });

  it("spec_list reports non-ENOENT errors in response", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const result = await server.getHandler("spec_list")({});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.error).toContain("permission denied");
    expect(data.files).toEqual([]);
  });

  it("spec_runs_list returns isError when listSpecRuns throws", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockListSpecRuns.mockImplementation(() => { throw new Error("DB not open"); });
    const result = await server.getHandler("spec_runs_list")({ limit: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("DB not open");
  });

  it("spec_run_status returns isError when getSpecRun throws", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockGetSpecRun.mockImplementation(() => { throw new Error("DB not open"); });
    const result = await server.getHandler("spec_run_status")({ runId: "sr-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("DB not open");
  });

  it("spec_runs_list returns spec runs", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockListSpecRuns.mockReturnValue([{ runId: "sr-1", status: "completed" }]);
    const result = await server.getHandler("spec_runs_list")({ limit: 10 });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(1);
  });

  it("spec_run_status returns isError for unknown runId", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    const result = await server.getHandler("spec_run_status")({ runId: "no-such-run" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("spec_run_status returns the spec run", async () => {
    const server = createMockServer();
    registerSpecTools(server as never, "/cwd");
    mockGetSpecRun.mockReturnValue({ runId: "sr-1", status: "completed", total: 1 });
    const result = await server.getHandler("spec_run_status")({ runId: "sr-1" });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.runId).toBe("sr-1");
  });
});

// ─── monitor tools ───────────────────────────────────────────

describe("registerMonitorTools", () => {
  it("registers status_get, runs_list, issues_list, issues_fetch", () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    const calls = server.tool.mock.calls.map(c => c[0]);
    expect(calls).toContain("status_get");
    expect(calls).toContain("runs_list");
    expect(calls).toContain("issues_list");
    expect(calls).toContain("issues_fetch");
  });

  it("status_get returns isError for unknown runId", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    const result = await server.getHandler("status_get")({ runId: "no-such-run" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("status_get returns run and tasks", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockGetRun.mockReturnValue({ runId: "run-1", status: "running" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", status: "pending" }]);
    const result = await server.getHandler("status_get")({ runId: "run-1" });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.run.runId).toBe("run-1");
    expect(data.tasks).toHaveLength(1);
  });

  it("runs_list returns all runs without status filter", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockListRuns.mockReturnValue([{ runId: "r1" }, { runId: "r2" }]);
    const result = await server.getHandler("runs_list")({ limit: 20 });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(2);
    expect(mockListRuns).toHaveBeenCalled();
  });

  it("runs_list filters by status when provided", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockListRunsByStatus.mockReturnValue([{ runId: "r1", status: "running" }]);
    const result = await server.getHandler("runs_list")({ status: "running", limit: 10 });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(1);
    expect(mockListRunsByStatus).toHaveBeenCalledWith("running", 10);
  });

  it("status_get returns isError when getRun throws", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockGetRun.mockImplementation(() => { throw new Error("DB not open"); });
    const result = await server.getHandler("status_get")({ runId: "run-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("DB not open");
  });

  it("runs_list returns isError when listRuns throws", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockListRuns.mockImplementation(() => { throw new Error("DB not open"); });
    const result = await server.getHandler("runs_list")({ limit: 20 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("DB not open");
  });

  it("issues_list returns isError when no source configured", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockLoadConfig.mockResolvedValue({ source: undefined });
    const result = await server.getHandler("issues_list")({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No datasource configured");
  });

  it("issues_list returns issues from datasource", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    const result = await server.getHandler("issues_list")({});
    const data = JSON.parse(result.content[0]!.text);
    expect(Array.isArray(data)).toBe(true);
  });

  it("issues_list returns isError on datasource exception", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockLoadConfig.mockRejectedValueOnce(new Error("config read failed"));
    const result = await server.getHandler("issues_list")({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("config read failed");
  });

  it("issues_fetch returns isError when no source configured", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    mockLoadConfig.mockResolvedValue({ source: undefined });
    const result = await server.getHandler("issues_fetch")({ issueIds: ["1"] });
    expect(result.isError).toBe(true);
  });

  it("issues_fetch returns fetched issue details", async () => {
    const server = createMockServer();
    registerMonitorTools(server as never, "/cwd");
    const result = await server.getHandler("issues_fetch")({ issueIds: ["1", "2"] });
    const data = JSON.parse(result.content[0]!.text);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
  });
});

// ─── recovery tools ──────────────────────────────────────────

describe("registerRecoveryTools", () => {
  it("registers run_retry and task_retry tools", () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    const calls = server.tool.mock.calls.map(c => c[0]);
    expect(calls).toContain("run_retry");
    expect(calls).toContain("task_retry");
  });

  it("run_retry returns isError for unknown runId", async () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    const result = await server.getHandler("run_retry")({ runId: "no-such" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("run_retry returns no-failed-tasks message when there are no failed tasks", async () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "completed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", status: "success" }]);
    const result = await server.getHandler("run_retry")({ runId: "run-1" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.message).toContain("No failed tasks");
  });

  it("run_retry creates a new run and returns newRunId when there are failed tasks", async () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([
      { taskId: "t:1", status: "success" },
      { taskId: "t:2", status: "failed" },
    ]);
    mockCreateRun.mockReturnValue("new-run-id");
    const result = await server.getHandler("run_retry")({ runId: "run-1" });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.runId).toBe("new-run-id");
    expect(data.status).toBe("running");
    expect(data.originalRunId).toBe("run-1");
  });

  it("task_retry returns isError for unknown runId", async () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    const result = await server.getHandler("task_retry")({ runId: "no-such", taskId: "t:1" });
    expect(result.isError).toBe(true);
  });

  it("task_retry returns isError for unknown taskId", async () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", status: "failed" }]);
    const result = await server.getHandler("task_retry")({ runId: "run-1", taskId: "t:99" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("task_retry creates a new run and returns newRunId", async () => {
    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", taskText: "Do thing", status: "failed" }]);
    mockCreateRun.mockReturnValue("new-run-id-2");
    const result = await server.getHandler("task_retry")({ runId: "run-1", taskId: "t:1" });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.runId).toBe("new-run-id-2");
    expect(data.taskId).toBe("t:1");
  });

  it("run_retry background: fires progress callbacks and finishes run", async () => {
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", status: "failed" }]);
    mockCreateRun.mockReturnValue("new-run-id");

    mockOrchestrate.mockImplementation(async (opts: { progressCallback?: (e: Record<string, unknown>) => void }) => {
      opts.progressCallback?.({ type: "task_start", taskId: "t:1", taskText: "Retry thing" });
      opts.progressCallback?.({ type: "task_done", taskId: "t:1", taskText: "Retry thing" });
      opts.progressCallback?.({ type: "task_failed", taskId: "t:2", taskText: "Other", error: "fail" });
      opts.progressCallback?.({ type: "phase_change", phase: "executing", message: "Executing" });
      opts.progressCallback?.({ type: "phase_change", phase: "planning" }); // no message
      opts.progressCallback?.({ type: "log", message: "retry log" });
      return { total: 2, completed: 1, failed: 1 };
    });

    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    await server.getHandler("run_retry")({ runId: "run-1" });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("new-run-id", "t:1", "running");
    expect(mockFinishRun).toHaveBeenCalledWith("new-run-id", "failed");
  });

  it("run_retry background: finishes run as failed on error", async () => {
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", status: "failed" }]);
    mockCreateRun.mockReturnValue("new-run-id");
    mockBootOrchestrator.mockRejectedValueOnce(new Error("retry boot failed"));

    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    await server.getHandler("run_retry")({ runId: "run-1" });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockFinishRun).toHaveBeenCalledWith("new-run-id", "failed", "retry boot failed");
  });

  it("task_retry background: fires progress callbacks and finishes run", async () => {
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", taskText: "Do thing", status: "failed" }]);
    mockCreateRun.mockReturnValue("task-retry-run-id");

    mockOrchestrate.mockImplementation(async (opts: { progressCallback?: (e: Record<string, unknown>) => void }) => {
      opts.progressCallback?.({ type: "task_start", taskId: "t:1", taskText: "Do thing" });
      opts.progressCallback?.({ type: "task_done", taskId: "t:1", taskText: "Do thing" });
      opts.progressCallback?.({ type: "task_failed", taskId: "t:1", taskText: "Do thing", error: "err" });
      opts.progressCallback?.({ type: "phase_change", phase: "executing", message: "Executing" });
      opts.progressCallback?.({ type: "phase_change", phase: "planning" }); // no message
      opts.progressCallback?.({ type: "log", message: "task retry log" });
      return { total: 1, completed: 1, failed: 0 };
    });

    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    await server.getHandler("task_retry")({ runId: "run-1", taskId: "t:1" });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockFinishRun).toHaveBeenCalledWith("task-retry-run-id", "completed");
  });

  it("task_retry background: finishes run as failed on error", async () => {
    mockGetRun.mockReturnValue({ runId: "run-1", issueIds: '["42"]', status: "failed" });
    mockGetTasksForRun.mockReturnValue([{ taskId: "t:1", taskText: "Do thing", status: "failed" }]);
    mockCreateRun.mockReturnValue("task-retry-run-id");
    mockBootOrchestrator.mockRejectedValueOnce(new Error("task retry boot failed"));

    const server = createMockServer();
    registerRecoveryTools(server as never, "/cwd");
    await server.getHandler("task_retry")({ runId: "run-1", taskId: "t:1" });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockFinishRun).toHaveBeenCalledWith("task-retry-run-id", "failed", "task retry boot failed");
  });
});

// ─── config tools ────────────────────────────────────────────

describe("registerConfigTools", () => {
  it("registers config_get tool", () => {
    const server = createMockServer();
    registerConfigTools(server as never, "/cwd");
    expect(server.tool).toHaveBeenCalledWith("config_get", expect.any(String), {}, expect.any(Function));
  });

  it("config_get returns config without nextIssueId", async () => {
    const server = createMockServer();
    registerConfigTools(server as never, "/cwd");
    mockLoadConfig.mockResolvedValue({
      source: "github",
      provider: "opencode",
      nextIssueId: 99,
    });
    const result = await server.getHandler("config_get")({});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.source).toBe("github");
    expect(data.nextIssueId).toBeUndefined();
  });
});
