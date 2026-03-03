import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ProviderInstance } from "../providers/interface.js";
import type { Datasource, DatasourceName, IssueDetails } from "../datasources/interface.js";
import type { Task } from "../parser.js";

export function createMockProvider(overrides?: Partial<ProviderInstance>): ProviderInstance {
  return {
    name: "mock",
    model: "mock-model",
    createSession: vi.fn<ProviderInstance["createSession"]>().mockResolvedValue("session-1"),
    prompt: vi.fn<ProviderInstance["prompt"]>().mockResolvedValue("done"),
    cleanup: vi.fn<ProviderInstance["cleanup"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createMockDatasource(name?: DatasourceName, overrides?: Partial<Datasource>): Datasource {
  return {
    name: name ?? "github",
    list: vi.fn<Datasource["list"]>().mockResolvedValue([]),
    fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue({
      number: "42",
      title: "My Feature",
      body: "Feature body",
      labels: [],
      state: "open",
      url: "https://github.com/org/repo/issues/42",
      comments: [],
      acceptanceCriteria: "",
    }),
    update: vi.fn<Datasource["update"]>().mockResolvedValue(undefined),
    close: vi.fn<Datasource["close"]>().mockResolvedValue(undefined),
    create: vi.fn<Datasource["create"]>().mockResolvedValue({
      number: "99",
      title: "My Feature",
      body: "Spec content",
      labels: [],
      state: "open",
      url: "https://github.com/org/repo/issues/99",
      comments: [],
      acceptanceCriteria: "",
    }),
    getDefaultBranch: vi.fn<Datasource["getDefaultBranch"]>().mockResolvedValue("main"),
    getUsername: vi.fn<Datasource["getUsername"]>().mockResolvedValue("testuser"),
    buildBranchName: vi.fn<Datasource["buildBranchName"]>().mockReturnValue("testuser/dispatch/1-test"),
    createAndSwitchBranch: vi.fn<Datasource["createAndSwitchBranch"]>().mockResolvedValue(undefined),
    switchBranch: vi.fn<Datasource["switchBranch"]>().mockResolvedValue(undefined),
    pushBranch: vi.fn<Datasource["pushBranch"]>().mockResolvedValue(undefined),
    commitAllChanges: vi.fn<Datasource["commitAllChanges"]>().mockResolvedValue(undefined),
    createPullRequest: vi.fn<Datasource["createPullRequest"]>().mockResolvedValue("https://github.com/org/repo/pull/1"),
    ...overrides,
  };
}

export function createMockTask(overrides?: Partial<Task>): Task {
  return {
    index: 0,
    text: "Implement the widget",
    line: 3,
    raw: "- [ ] Implement the widget",
    file: "/tmp/test/42-feature.md",
    ...overrides,
  };
}

export function createMockIssueDetails(overrides?: Partial<IssueDetails>): IssueDetails {
  return {
    number: "1",
    title: "Default Title",
    body: "Default body content",
    labels: [],
    state: "open",
    url: "https://github.com/org/repo/issues/1",
    comments: [],
    acceptanceCriteria: "",
    ...overrides,
  };
}

export function createMockChildProcess(overrides?: Partial<Pick<ChildProcess, "pid" | "exitCode" | "killed" | "signalCode">>): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null] as ChildProcess["stdio"],
    killed: false,
    pid: 1234,
    connected: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    spawnargs: [] as string[],
    spawnfile: "",
    kill: vi.fn<ChildProcess["kill"]>().mockReturnValue(true),
    send: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    ...overrides,
  });

  return child as unknown as ChildProcess;
}
