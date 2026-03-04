import { vi, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import type { ProviderInstance } from "../providers/interface.js";
import type { Datasource, IssueDetails } from "../datasources/interface.js";
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

export function createMockDatasource(overrides?: Partial<Datasource>): Datasource {
  return {
    name: "github",
    supportsGit: vi.fn<Datasource["supportsGit"]>().mockReturnValue(true),
    list: vi.fn<Datasource["list"]>().mockResolvedValue([]),
    fetch: vi.fn<Datasource["fetch"]>().mockResolvedValue({} as IssueDetails),
    update: vi.fn<Datasource["update"]>().mockResolvedValue(undefined),
    close: vi.fn<Datasource["close"]>().mockResolvedValue(undefined),
    create: vi.fn<Datasource["create"]>().mockResolvedValue({} as IssueDetails),
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

export interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: Mock;
}

export function createMockChildProcess(): MockChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }) satisfies MockChildProcess;
  return child;
}

/**
 * Callback-style implementation for an execFile mock intended to be wrapped with util.promisify.
 *
 * util.promisify does not create a `{ stdout, stderr }` object by itself; it simply resolves
 * with whatever non-error arguments are passed to the callback. In this test helper, the mock
 * implementation is expected to call `cb(null, { stdout, stderr })`, so the promisified wrapper
 * resolves to that single result object.
 *
 * Note: the real `child_process.execFile` callback has the shape `(error, stdout, stderr)`.
 * This helper uses a different, test-only callback shape for convenience.
 */
export type ExecFileMockImpl = (
  cmd: string,
  args: readonly string[] | null,
  opts: Record<string, unknown>,
  cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
) => void;

/** Apply a typed mock implementation to a mocked execFile function. */
export function mockExecFile(mock: Mock, impl: ExecFileMockImpl): void {
  mock.mockImplementation(impl);
}
