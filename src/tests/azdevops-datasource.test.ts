import { describe, it, expect, vi, beforeEach } from "vitest";

// Git execFile mock — still needed for git operations
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

// Azure DevOps SDK mocks
const mockWitApi = vi.hoisted(() => ({
  queryByWiql: vi.fn(),
  getWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
  getWorkItemTypes: vi.fn(),
  getWorkItemTypeStates: vi.fn(),
  getComments: vi.fn(),
}));

const mockGitApi = vi.hoisted(() => ({
  getRepositories: vi.fn(),
  createPullRequest: vi.fn(),
  getPullRequests: vi.fn(),
}));

const mockConnection = vi.hoisted(() => ({
  getWorkItemTrackingApi: vi.fn().mockResolvedValue(mockWitApi),
  getGitApi: vi.fn().mockResolvedValue(mockGitApi),
}));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

// Mock auth module to return our mock connection
vi.mock("../helpers/auth.js", () => ({
  getAzureConnection: vi.fn().mockResolvedValue(mockConnection),
}));

// Mock datasource index — preserve real parseAzDevOpsRemoteUrl and other exports,
// but mock getGitRemoteUrl to return a valid Azure DevOps URL
vi.mock("../datasources/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../datasources/index.js")>();
  return {
    ...original,
    getGitRemoteUrl: vi.fn().mockResolvedValue("https://dev.azure.com/testorg/testproject/_git/testrepo"),
  };
});

// Mock azure-devops-node-api interfaces import used for PullRequestStatus
vi.mock("azure-devops-node-api/interfaces/GitInterfaces.js", () => ({
  PullRequestStatus: { Active: 1 },
}));

import { datasource, detectWorkItemType, detectDoneState } from "../datasources/azdevops.js";
import { InvalidBranchNameError } from "../helpers/branch-validation.js";

const SHELL = process.platform === "win32";

beforeEach(() => {
  mockExecFile.mockReset();
  mockWitApi.queryByWiql.mockReset();
  mockWitApi.getWorkItems.mockReset();
  mockWitApi.getWorkItem.mockReset();
  mockWitApi.updateWorkItem.mockReset();
  mockWitApi.createWorkItem.mockReset();
  mockWitApi.getWorkItemTypes.mockReset();
  mockWitApi.getWorkItemTypeStates.mockReset();
  mockWitApi.getComments.mockReset();
  mockGitApi.getRepositories.mockReset();
  mockGitApi.createPullRequest.mockReset();
  mockGitApi.getPullRequests.mockReset();
});

describe("azdevops datasource — list", () => {
  it("queries work items and fetches details", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({
      workItems: [{ id: 1 }, { id: 2 }],
    });
    mockWitApi.getWorkItems.mockResolvedValueOnce([
      {
        id: 1,
        fields: { "System.Title": "Bug", "System.Description": "fix", "System.Tags": "bug", "System.State": "Active" },
        _links: { html: { href: "https://dev.azure.com/1" } },
      },
      {
        id: 2,
        fields: { "System.Title": "Feature", "System.Description": "add", "System.Tags": "", "System.State": "New" },
        url: "https://dev.azure.com/2",
      },
    ]);
    mockWitApi.getComments.mockResolvedValue({ comments: [] });

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(result[0].number).toBe("1");
    expect(result[0].title).toBe("Bug");
    expect(result[1].number).toBe("2");

    // Verify batch call was made with correct ids
    expect(mockWitApi.getWorkItems).toHaveBeenCalledWith([1, 2]);
  });

  it("falls back to individual fetches when batch call fails", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({
      workItems: [{ id: 1 }],
    });
    mockWitApi.getWorkItems.mockRejectedValueOnce(new Error("batch not supported"));
    // Fallback path calls datasource.fetch() which calls getWorkItem
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 1,
      fields: { "System.Title": "Bug", "System.Description": "fix", "System.Tags": "", "System.State": "Active" },
      _links: { html: { href: "https://dev.azure.com/1" } },
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe("1");
    expect(result[0].title).toBe("Bug");
  });

  it("passes org and project to SDK calls", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });

    await datasource.list({ cwd: "/tmp", org: "https://dev.azure.com/myorg", project: "MyProj" });

    // When org and project are provided, the method completes without error
    expect(mockWitApi.queryByWiql).toHaveBeenCalledTimes(1);
  });

  it("returns early when WIQL result is empty", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({
      workItems: [],
    });

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toEqual([]);
    // getWorkItems should NOT have been called
    expect(mockWitApi.getWorkItems).not.toHaveBeenCalled();
  });

  it("passes ids through on batch call", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({
      workItems: [{ id: 1 }],
    });
    mockWitApi.getWorkItems.mockResolvedValueOnce([
      {
        id: 1,
        fields: { "System.Title": "T", "System.Description": "D", "System.Tags": "", "System.State": "Active" },
        _links: { html: { href: "https://dev.azure.com/1" } },
      },
    ]);
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    await datasource.list({ cwd: "/tmp", org: "https://dev.azure.com/myorg", project: "MyProj" });

    expect(mockWitApi.getWorkItems).toHaveBeenCalledWith([1]);
  });

  it("appends iteration filter to WIQL query", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });
    await datasource.list({ cwd: "/tmp", iteration: "MyProject\\Sprint 1" });
    const wiqlArg = mockWitApi.queryByWiql.mock.calls[0][0];
    expect(wiqlArg.query).toContain("[System.IterationPath] UNDER 'MyProject\\Sprint 1'");
  });

  it("appends area filter to WIQL query", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });
    await datasource.list({ cwd: "/tmp", area: "MyProject\\Team A" });
    const wiqlArg = mockWitApi.queryByWiql.mock.calls[0][0];
    expect(wiqlArg.query).toContain("[System.AreaPath] UNDER 'MyProject\\Team A'");
  });

  it("handles @CurrentIteration macro without quotes", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });
    await datasource.list({ cwd: "/tmp", iteration: "@CurrentIteration" });
    const wiqlArg = mockWitApi.queryByWiql.mock.calls[0][0];
    expect(wiqlArg.query).toContain("[System.IterationPath] UNDER @CurrentIteration");
  });

  it("appends both iteration and area filters", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });
    await datasource.list({ cwd: "/tmp", iteration: "MyProject\\Sprint 1", area: "MyProject\\Team A" });
    const wiqlArg = mockWitApi.queryByWiql.mock.calls[0][0];
    expect(wiqlArg.query).toContain("[System.IterationPath] UNDER 'MyProject\\Sprint 1'");
    expect(wiqlArg.query).toContain("[System.AreaPath] UNDER 'MyProject\\Team A'");
  });

  it("does not add iteration or area filters when neither is set", async () => {
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });
    await datasource.list({ cwd: "/tmp" });

    const wiqlArg = mockWitApi.queryByWiql.mock.calls[0][0];
    expect(wiqlArg.query).not.toContain("[System.IterationPath]");
    expect(wiqlArg.query).not.toContain("[System.AreaPath]");
    expect(wiqlArg.query).toContain("[System.State] <> 'Closed'");
    expect(wiqlArg.query).toContain("[System.State] <> 'Done'");
    expect(wiqlArg.query).toContain("[System.State] <> 'Removed'");
  });

  it("propagates SDK errors", async () => {
    mockWitApi.queryByWiql.mockRejectedValueOnce(new Error("SDK connection failed"));

    await expect(datasource.list({ cwd: "/tmp" })).rejects.toThrow(
      "SDK connection failed"
    );
  });
});

describe("azdevops datasource — fetch", () => {
  it("returns issue details", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 42,
      fields: {
        "System.Title": "Auth bug",
        "System.Description": "login broken",
        "System.Tags": "bug;critical",
        "System.State": "Active",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "must fix",
      },
      _links: { html: { href: "https://dev.azure.com/42" } },
    });
    mockWitApi.getComments.mockResolvedValueOnce({
      comments: [{ text: "looking into it", createdBy: { displayName: "Alice" } }],
    });

    const result = await datasource.fetch("42", { cwd: "/tmp" });

    expect(result.number).toBe("42");
    expect(result.title).toBe("Auth bug");
    expect(result.labels).toEqual(["bug", "critical"]);
    expect(result.comments).toEqual(["**Alice:** looking into it"]);
    expect(result.acceptanceCriteria).toBe("must fix");
  });

  it("handles fetch with org and project", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 1,
      fields: {},
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    await datasource.fetch("1", { cwd: "/tmp", org: "https://dev.azure.com/org-url", project: "proj" });

    expect(mockWitApi.getWorkItem).toHaveBeenCalledWith(1);
  });

  it("returns empty comments when fetchComments fails", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 1,
      fields: { "System.Title": "T" },
    });
    mockWitApi.getComments.mockRejectedValueOnce(new Error("comment fetch failed"));

    const result = await datasource.fetch("1", { cwd: "/tmp" });

    expect(result.comments).toEqual([]);
  });

  it("propagates SDK errors from getWorkItem", async () => {
    mockWitApi.getWorkItem.mockRejectedValueOnce(new Error("auth required"));

    await expect(datasource.fetch("42", { cwd: "/tmp" })).rejects.toThrow(
      "auth required"
    );
  });

  it("populates new IssueDetails fields when present in API response", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 50,
      fields: {
        "System.Title": "Add login",
        "System.Description": "implement login",
        "System.Tags": "feature",
        "System.State": "Active",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "works",
        "System.IterationPath": "MyProject\\Sprint 5",
        "System.AreaPath": "MyProject\\Backend",
        "System.AssignedTo": { displayName: "Jane Doe" },
        "Microsoft.VSTS.Common.Priority": 2,
        "Microsoft.VSTS.Scheduling.StoryPoints": 8,
        "System.WorkItemType": "User Story",
      },
      _links: { html: { href: "https://dev.azure.com/50" } },
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    const result = await datasource.fetch("50", { cwd: "/tmp" });

    expect(result.iterationPath).toBe("MyProject\\Sprint 5");
    expect(result.areaPath).toBe("MyProject\\Backend");
    expect(result.assignee).toBe("Jane Doe");
    expect(result.priority).toBe(2);
    expect(result.storyPoints).toBe(8);
    expect(result.workItemType).toBe("User Story");
  });

  it("returns undefined for new fields when absent from API response", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 51,
      fields: {
        "System.Title": "Minimal item",
        "System.Description": "",
        "System.Tags": "",
        "System.State": "New",
      },
      _links: { html: { href: "https://dev.azure.com/51" } },
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    const result = await datasource.fetch("51", { cwd: "/tmp" });

    expect(result.iterationPath).toBeUndefined();
    expect(result.areaPath).toBeUndefined();
    expect(result.assignee).toBeUndefined();
    expect(result.priority).toBeUndefined();
    expect(result.storyPoints).toBeUndefined();
    expect(result.workItemType).toBeUndefined();
  });

  it("falls back across story point field variants (Agile → Scrum → CMMI)", async () => {
    // Agile: uses StoryPoints
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 60,
      fields: {
        "System.Title": "Agile item",
        "Microsoft.VSTS.Scheduling.StoryPoints": 5,
      },
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    const agile = await datasource.fetch("60", { cwd: "/tmp" });
    expect(agile.storyPoints).toBe(5);

    // Scrum: uses Effort
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 61,
      fields: {
        "System.Title": "Scrum item",
        "Microsoft.VSTS.Scheduling.Effort": 13,
      },
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    const scrum = await datasource.fetch("61", { cwd: "/tmp" });
    expect(scrum.storyPoints).toBe(13);

    // CMMI: uses Size
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 62,
      fields: {
        "System.Title": "CMMI item",
        "Microsoft.VSTS.Scheduling.Size": 3,
      },
    });
    mockWitApi.getComments.mockResolvedValueOnce({ comments: [] });

    const cmmi = await datasource.fetch("62", { cwd: "/tmp" });
    expect(cmmi.storyPoints).toBe(3);
  });
});

describe("azdevops datasource — update", () => {
  it("calls witApi.updateWorkItem", async () => {
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.update("42", "New Title", "New Body", { cwd: "/tmp" });

    expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
      null,
      [
        { op: "add", path: "/fields/System.Title", value: "New Title" },
        { op: "add", path: "/fields/System.Description", value: "New Body" },
      ],
      42,
    );
  });

  it("passes org and project when provided", async () => {
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.update("1", "T", "B", { cwd: "/tmp", org: "https://dev.azure.com/org-url", project: "proj" });

    expect(mockWitApi.updateWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe("azdevops datasource — close", () => {
  it("detects done state dynamically via work item type", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 42,
      fields: { "System.WorkItemType": "User Story" },
    });
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New", category: "Proposed" },
      { name: "Active", category: "InProgress" },
      { name: "Closed", category: "Completed" },
    ]);
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.close("42", { cwd: "/tmp", org: "https://dev.azure.com/close-org1", project: "close-proj1" });

    // Verify the update used the detected state
    expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: "add", path: "/fields/System.State", value: "Closed" }],
      42,
    );
  });

  it("resolves to Done for Scrum process template", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 42,
      fields: { "System.WorkItemType": "Product Backlog Item" },
    });
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New", category: "Proposed" },
      { name: "Approved", category: "InProgress" },
      { name: "Committed", category: "InProgress" },
      { name: "Done", category: "Completed" },
    ]);
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.close("42", { cwd: "/tmp", org: "https://dev.azure.com/scrum-org", project: "scrum-proj" });

    expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: "add", path: "/fields/System.State", value: "Done" }],
      42,
    );
  });

  it("uses opts.workItemType to skip fetching work item", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New", category: "Proposed" },
      { name: "Done", category: "Completed" },
    ]);
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.close("42", { cwd: "/tmp", workItemType: "Product Backlog Item", org: "https://dev.azure.com/close-org2", project: "close-proj2" });

    // Should NOT have called getWorkItem
    expect(mockWitApi.getWorkItem).not.toHaveBeenCalled();
    expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: "add", path: "/fields/System.State", value: "Done" }],
      42,
    );
  });

  it("falls back to Closed when state detection fails", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 42,
      fields: { "System.WorkItemType": "Bug" },
    });
    mockWitApi.getWorkItemTypeStates.mockRejectedValueOnce(new Error("API error"));
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.close("42", { cwd: "/tmp", org: "https://dev.azure.com/close-org3", project: "close-proj3" });

    expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: "add", path: "/fields/System.State", value: "Closed" }],
      42,
    );
  });

  it("falls back to Closed when work item has no type", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 42,
      fields: {},
    });
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.close("42", { cwd: "/tmp", org: "https://dev.azure.com/close-org4", project: "close-proj4" });

    expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: "add", path: "/fields/System.State", value: "Closed" }],
      42,
    );
  });

  it("passes org and project when provided", async () => {
    mockWitApi.getWorkItem.mockResolvedValueOnce({
      id: 42,
      fields: { "System.WorkItemType": "User Story" },
    });
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "Closed", category: "Completed" },
    ]);
    mockWitApi.updateWorkItem.mockResolvedValueOnce({});

    await datasource.close("42", { cwd: "/tmp", org: "https://dev.azure.com/close-org5", project: "close-proj5" });

    expect(mockWitApi.updateWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe("azdevops datasource — create", () => {
  it("creates a work item using detected type when workItemType not provided", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([{ name: "User Story" }, { name: "Bug" }]);
    mockWitApi.createWorkItem.mockResolvedValueOnce({
      id: 99,
      fields: {
        "System.Title": "New Item",
        "System.Description": "desc",
        "System.Tags": "",
        "System.State": "New",
      },
      _links: { html: { href: "https://dev.azure.com/99" } },
    });

    const result = await datasource.create("New Item", "desc", { cwd: "/tmp" });

    expect(result.number).toBe("99");
    expect(result.title).toBe("New Item");
    expect(result.state).toBe("New");
    // Verify the create call used the detected type
    expect(mockWitApi.createWorkItem).toHaveBeenCalledWith(
      null,
      expect.any(Array),
      "testproject",
      "User Story",
    );
  });

  it("uses opts.workItemType when provided", async () => {
    mockWitApi.createWorkItem.mockResolvedValueOnce({
      id: 100,
      fields: {
        "System.Title": "Item",
        "System.Description": "body",
        "System.Tags": "",
        "System.State": "New",
      },
      _links: { html: { href: "https://dev.azure.com/100" } },
    });

    const result = await datasource.create("Item", "body", {
      cwd: "/tmp",
      workItemType: "Product Backlog Item",
    });

    expect(result.number).toBe("100");
    // Should NOT have called getWorkItemTypes (detectWorkItemType skipped)
    expect(mockWitApi.getWorkItemTypes).not.toHaveBeenCalled();
    expect(mockWitApi.createWorkItem).toHaveBeenCalledWith(
      null,
      expect.any(Array),
      "testproject",
      "Product Backlog Item",
    );
  });

  it("throws descriptive error when type cannot be determined", async () => {
    mockWitApi.getWorkItemTypes.mockRejectedValueOnce(new Error("API not found"));

    await expect(
      datasource.create("Title", "Body", { cwd: "/tmp" }),
    ).rejects.toThrow("Could not determine work item type");
  });

  it("propagates SDK errors from createWorkItem", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([{ name: "User Story" }]);
    mockWitApi.createWorkItem.mockRejectedValueOnce(new Error("not authorized"));

    await expect(
      datasource.create("Title", "Body", { cwd: "/tmp" })
    ).rejects.toThrow("not authorized");
  });

  it("populates new metadata fields when present in create response", async () => {
    mockWitApi.createWorkItem.mockResolvedValueOnce({
      id: 200,
      fields: {
        "System.Title": "Rich Item",
        "System.Description": "detailed",
        "System.Tags": "epic;backend",
        "System.State": "New",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "all tests pass",
        "System.IterationPath": "MyProject\\Sprint 3",
        "System.AreaPath": "MyProject\\API",
        "System.AssignedTo": { displayName: "Bob Smith" },
        "Microsoft.VSTS.Common.Priority": 1,
        "Microsoft.VSTS.Scheduling.StoryPoints": 13,
        "System.WorkItemType": "User Story",
      },
      _links: { html: { href: "https://dev.azure.com/200" } },
    });

    const result = await datasource.create("Rich Item", "detailed", {
      cwd: "/tmp",
      workItemType: "User Story",
    });

    expect(result.number).toBe("200");
    expect(result.iterationPath).toBe("MyProject\\Sprint 3");
    expect(result.areaPath).toBe("MyProject\\API");
    expect(result.assignee).toBe("Bob Smith");
    expect(result.priority).toBe(1);
    expect(result.storyPoints).toBe(13);
    expect(result.workItemType).toBe("User Story");
  });

  it("returns undefined for new metadata fields when absent from create response", async () => {
    mockWitApi.createWorkItem.mockResolvedValueOnce({
      id: 201,
      fields: {
        "System.Title": "Bare Item",
        "System.Description": "minimal",
        "System.Tags": "",
        "System.State": "New",
      },
      _links: { html: { href: "https://dev.azure.com/201" } },
    });

    const result = await datasource.create("Bare Item", "minimal", {
      cwd: "/tmp",
      workItemType: "Bug",
    });

    expect(result.number).toBe("201");
    expect(result.iterationPath).toBeUndefined();
    expect(result.areaPath).toBeUndefined();
    expect(result.assignee).toBeUndefined();
    expect(result.priority).toBeUndefined();
    expect(result.storyPoints).toBeUndefined();
    // workItemType falls back to the local value when API omits it
    expect(result.workItemType).toBe("Bug");
  });

  it("falls back workItemType to local value when API response omits System.WorkItemType", async () => {
    // detectWorkItemType returns "User Story"
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([{ name: "User Story" }]);
    // create response omits System.WorkItemType
    mockWitApi.createWorkItem.mockResolvedValueOnce({
      id: 202,
      fields: {
        "System.Title": "No Type Field",
        "System.Description": "body",
        "System.Tags": "",
        "System.State": "New",
      },
      _links: { html: { href: "https://dev.azure.com/202" } },
    });

    const result = await datasource.create("No Type Field", "body", { cwd: "/tmp" });

    expect(result.workItemType).toBe("User Story");
  });
});

describe("detectWorkItemType", () => {
  it("returns 'User Story' when available", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([
      { name: "Bug" },
      { name: "User Story" },
      { name: "Task" },
    ]);

    const result = await detectWorkItemType({ cwd: "/tmp", org: "https://dev.azure.com/org-url", project: "proj" });

    expect(result).toBe("User Story");
  });

  it("returns 'Product Backlog Item' for Scrum template", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([
      { name: "Bug" },
      { name: "Product Backlog Item" },
      { name: "Task" },
    ]);

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Product Backlog Item");
  });

  it("returns 'Requirement' for CMMI template", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([
      { name: "Bug" },
      { name: "Requirement" },
      { name: "Task" },
    ]);

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Requirement");
  });

  it("returns 'Issue' when no higher-priority types exist", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([
      { name: "Bug" },
      { name: "Issue" },
      { name: "Task" },
    ]);

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Issue");
  });

  it("falls back to first type when no preferred types match", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([
      { name: "Custom Item" },
      { name: "Task" },
    ]);

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Custom Item");
  });

  it("returns null on failure", async () => {
    mockWitApi.getWorkItemTypes.mockRejectedValueOnce(new Error("API not found"));

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBeNull();
  });

  it("returns null for empty type list", async () => {
    mockWitApi.getWorkItemTypes.mockResolvedValueOnce([]);

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBeNull();
  });
});

describe("detectDoneState", () => {
  it("returns the state with Completed category", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New", category: "Proposed" },
      { name: "Active", category: "InProgress" },
      { name: "Done", category: "Completed" },
    ]);

    const result = await detectDoneState("Product Backlog Item", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org1",
      project: "proj1",
    });

    expect(result).toBe("Done");
    expect(mockWitApi.getWorkItemTypeStates).toHaveBeenCalledWith("proj1", "Product Backlog Item");
  });

  it("returns Closed when category is Completed for Agile template", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New", category: "Proposed" },
      { name: "Active", category: "InProgress" },
      { name: "Closed", category: "Completed" },
    ]);

    const result = await detectDoneState("User Story", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org2",
      project: "proj2",
    });

    expect(result).toBe("Closed");
  });

  it("falls back to Done when no Completed category exists", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New" },
      { name: "Active" },
      { name: "Done" },
    ]);

    const result = await detectDoneState("Product Backlog Item", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org3",
      project: "proj3",
    });

    expect(result).toBe("Done");
  });

  it("falls back to Closed when Done is not available", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New" },
      { name: "Active" },
      { name: "Closed" },
    ]);

    const result = await detectDoneState("User Story", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org4",
      project: "proj4",
    });

    expect(result).toBe("Closed");
  });

  it("falls back to Resolved when Done and Closed are not available", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New" },
      { name: "Active" },
      { name: "Resolved" },
    ]);

    const result = await detectDoneState("Requirement", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org5",
      project: "proj5",
    });

    expect(result).toBe("Resolved");
  });

  it("falls back to Completed when only Completed state exists", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New" },
      { name: "Active" },
      { name: "Completed" },
    ]);

    const result = await detectDoneState("Custom Item", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org6",
      project: "proj6",
    });

    expect(result).toBe("Completed");
  });

  it("defaults to Closed when no known terminal states exist", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "New" },
      { name: "Active" },
      { name: "Custom Final" },
    ]);

    const result = await detectDoneState("Custom Item", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org7",
      project: "proj7",
    });

    expect(result).toBe("Closed");
  });

  it("defaults to Closed on API error", async () => {
    mockWitApi.getWorkItemTypeStates.mockRejectedValueOnce(new Error("API not found"));

    const result = await detectDoneState("User Story", {
      cwd: "/tmp",
      org: "https://dev.azure.com/org8",
      project: "proj8",
    });

    expect(result).toBe("Closed");
  });

  it("returns cached result on subsequent calls", async () => {
    mockWitApi.getWorkItemTypeStates.mockResolvedValueOnce([
      { name: "Done", category: "Completed" },
    ]);

    const first = await detectDoneState("PBI", {
      cwd: "/tmp",
      org: "https://dev.azure.com/cached-org",
      project: "cached-proj",
    });
    const second = await detectDoneState("PBI", {
      cwd: "/tmp",
      org: "https://dev.azure.com/cached-org",
      project: "cached-proj",
    });

    expect(first).toBe("Done");
    expect(second).toBe("Done");
    // Only one API call should have been made
    expect(mockWitApi.getWorkItemTypeStates).toHaveBeenCalledTimes(1);
  });
});

describe("azdevops datasource — getUsername", () => {
  it("returns opts.username when provided", async () => {
    const result = await datasource.getUsername({ cwd: "/tmp", username: "pr" });
    expect(result).toBe("pr");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("derives short username from multi-word git user.name", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Alice Smith\n" });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("alsmith");
  });

  it("falls back to email for single-word git user.name", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Alice\n" });
    mockExecFile.mockResolvedValueOnce({ stdout: "alice.smith@example.com\n" });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("alicesmi");
  });

  it("falls back to email when git user.name is empty", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "\n" });
    mockExecFile.mockResolvedValueOnce({ stdout: "dev@example.com\n" });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("dev");
  });

  it("returns unknown when both git config calls fail", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("unknown");
  });

  it("returns unknown when git config returns empty for both", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "\n" });
    mockExecFile.mockResolvedValueOnce({ stdout: "\n" });
    const result = await datasource.getUsername({ cwd: "/tmp" });
    expect(result).toBe("unknown");
  });
});

describe("azdevops datasource — getDefaultBranch", () => {
  it("returns branch from symbolic-ref", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/develop\n" });

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("develop");
  });

  it("falls back to main", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("main");
  });

  it("falls back to master", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal"))
      .mockRejectedValueOnce(new Error("fatal"));

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("master");
  });

  it("handles slashed branch names like release/2024", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/release/2024\n" });

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("release/2024");
  });

  it("handles deeply nested branch names like feature/team/sprint-1", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/feature/team/sprint-1\n" });

    const result = await datasource.getDefaultBranch({ cwd: "/tmp" });
    expect(result).toBe("feature/team/sprint-1");
  });
});

describe("azdevops datasource — buildBranchName", () => {
  it("builds <username>/dispatch/issue-<number>", () => {
    const result = datasource.buildBranchName("42", "Add Auth Feature", "testuser");
    expect(result).toBe("testuser/dispatch/issue-42");
  });
});

describe("azdevops datasource — createAndSwitchBranch", () => {
  it("creates new branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git", ["checkout", "-b", "dispatch/42-feat"], { cwd: "/tmp", shell: SHELL },
    );
  });

  it("falls back to checkout if already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("prunes stale worktrees and retries checkout when branch is worktree-locked", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("fatal: a branch named 'dispatch/42-feat' already exists"))
      .mockRejectedValueOnce(new Error("fatal: 'dispatch/42-feat' is already used by worktree at '/tmp/stale-worktree'"))
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["checkout", "-b", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["checkout", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "prune"],
      { cwd: "/tmp", shell: SHELL },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      4,
      "git",
      ["checkout", "dispatch/42-feat"],
      { cwd: "/tmp", shell: SHELL },
    );
  });

  it("throws for other errors", async () => {
    mockExecFile.mockRejectedValue(new Error("permission denied"));

    await expect(
      datasource.createAndSwitchBranch("b", { cwd: "/tmp" }),
    ).rejects.toThrow("permission denied");
  });
});

describe("azdevops datasource — switchBranch", () => {
  it("calls git checkout", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });
    await datasource.switchBranch("main", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/tmp", shell: SHELL });
  });
});

describe("azdevops datasource — pushBranch", () => {
  it("calls git push with upstream", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });
    await datasource.pushBranch("dispatch/42-feat", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git", ["push", "--set-upstream", "origin", "dispatch/42-feat"], { cwd: "/tmp", shell: SHELL },
    );
  });
});

describe("azdevops datasource — commitAllChanges", () => {
  it("stages and commits when changes exist", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" }) // git add
      .mockResolvedValueOnce({ stdout: " 1 file changed\n" }) // git diff
      .mockResolvedValueOnce({ stdout: "" }); // git commit

    await datasource.commitAllChanges("feat: update", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("skips commit when no changes", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await datasource.commitAllChanges("feat: update", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe("azdevops datasource — createPullRequest", () => {
  const REPO = {
    id: "repo-id",
    remoteUrl: "https://dev.azure.com/testorg/testproject/_git/testrepo",
    webUrl: "https://dev.azure.com/testorg/testproject/_git/testrepo",
  };

  it("creates PR and returns URL", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([REPO]);
    mockGitApi.createPullRequest.mockResolvedValueOnce({ pullRequestId: 1 });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequest/1");
    expect(mockGitApi.createPullRequest).toHaveBeenCalledWith(
      {
        sourceRefName: "refs/heads/dispatch/42-feat",
        targetRefName: "refs/heads/main",
        title: "Title",
        description: "Body",
        workItemRefs: [{ id: "42" }],
      },
      "repo-id",
      "testproject",
    );
  });

  it("uses default description when body is empty", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([REPO]);
    mockGitApi.createPullRequest.mockResolvedValueOnce({ pullRequestId: 2 });

    await datasource.createPullRequest(
      "dispatch/99-fix", "99", "Fix bug", "", { cwd: "/tmp" },
    );

    expect(mockGitApi.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Resolves AB#99" }),
      "repo-id",
      "testproject",
    );
  });

  it("returns existing PR URL when already exists", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([REPO]);
    mockGitApi.createPullRequest.mockRejectedValueOnce(new Error("already exists"));
    mockGitApi.getPullRequests.mockResolvedValueOnce([{ pullRequestId: 5 }]);

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequest/5");
    expect(mockGitApi.getPullRequests).toHaveBeenCalledWith(
      "repo-id",
      { sourceRefName: "refs/heads/dispatch/42-feat", status: 1 },
      "testproject",
    );
  });

  it("returns empty string when existing PR list is empty", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([REPO]);
    mockGitApi.createPullRequest.mockRejectedValueOnce(new Error("already exists"));
    mockGitApi.getPullRequests.mockResolvedValueOnce([]);

    const url = await datasource.createPullRequest(
      "b", "1", "T", "B", { cwd: "/tmp" },
    );

    expect(url).toBe("");
  });

  it("throws for non-already-exists errors", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([REPO]);
    mockGitApi.createPullRequest.mockRejectedValueOnce(new Error("auth required"));

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" }),
    ).rejects.toThrow("auth required");
  });

  it("throws when no repository matches the remote URL", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([
      { id: "other-id", webUrl: "https://dev.azure.com/other/other/_git/other" },
    ]);

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" }),
    ).rejects.toThrow("Could not find Azure DevOps repository");
  });

  it("matches repository even when remote URL contains userinfo credentials", async () => {
    // Override getGitRemoteUrl to return a URL with embedded credentials
    const { getGitRemoteUrl } = await import("../datasources/index.js");
    vi.mocked(getGitRemoteUrl).mockResolvedValueOnce(
      "https://user:pat-token@dev.azure.com/testorg/testproject/_git/testrepo"
    );
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([REPO]);
    mockGitApi.createPullRequest.mockResolvedValueOnce({ pullRequestId: 10 });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequest/10");
  });
});

describe("azdevops datasource — getDefaultBranch validation", () => {
  it("rejects symbolic-ref output containing spaces", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/my branch\n" });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("rejects symbolic-ref output containing shell metacharacters", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/$(whoami)\n" });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("rejects symbolic-ref output with @{ reflog syntax", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/main@{0}\n" });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("rejects symbolic-ref output containing ..", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/a..b\n" });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("rejects symbolic-ref output ending with .lock", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/branch.lock\n" });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("rejects empty branch name from symbolic-ref", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/\n" });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("rejects branch name exceeding 255 characters", async () => {
    mockExecFile.mockResolvedValue({
      stdout: "refs/remotes/origin/" + "a".repeat(256) + "\n",
    });
    await expect(datasource.getDefaultBranch({ cwd: "/tmp" })).rejects.toThrow(
      "Invalid branch name"
    );
  });

  it("throws InvalidBranchNameError specifically", async () => {
    mockExecFile.mockResolvedValue({ stdout: "refs/remotes/origin/bad name\n" });
    await expect(
      datasource.getDefaultBranch({ cwd: "/tmp" })
    ).rejects.toBeInstanceOf(InvalidBranchNameError);
  });
});

describe("azdevops datasource — buildBranchName validation", () => {
  it("handles title with square brackets", () => {
    expect(datasource.buildBranchName("42", "[Bug] Fix login", "user")).toBe(
      "user/dispatch/issue-42"
    );
  });

  it("handles title with colons", () => {
    expect(datasource.buildBranchName("42", "feat: add endpoint", "user")).toBe(
      "user/dispatch/issue-42"
    );
  });

  it("handles title with mixed special characters", () => {
    expect(
      datasource.buildBranchName("42", "Fix @{upstream} issue", "user")
    ).toBe("user/dispatch/issue-42");
  });

  it("handles title with dots by replacing them with hyphens", () => {
    expect(datasource.buildBranchName("42", "Update v1.2.3", "user")).toBe(
      "user/dispatch/issue-42"
    );
  });
});

describe("azdevops datasource — createAndSwitchBranch validation", () => {
  it("rejects branch names with spaces", async () => {
    await expect(
      datasource.createAndSwitchBranch("bad branch", { cwd: "/tmp" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects branch names with @{", async () => {
    await expect(
      datasource.createAndSwitchBranch("main@{0}", { cwd: "/tmp" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects branch names containing ..", async () => {
    await expect(
      datasource.createAndSwitchBranch("a..b", { cwd: "/tmp" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects branch names ending with .lock", async () => {
    await expect(
      datasource.createAndSwitchBranch("branch.lock", { cwd: "/tmp" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("throws InvalidBranchNameError specifically", async () => {
    await expect(
      datasource.createAndSwitchBranch("bad name", { cwd: "/tmp" })
    ).rejects.toBeInstanceOf(InvalidBranchNameError);
  });

  it("does not call git when branch name is invalid", async () => {
    await expect(
      datasource.createAndSwitchBranch("bad name", { cwd: "/tmp" })
    ).rejects.toThrow("Invalid branch name");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("azdevops datasource — credential redaction in error messages", () => {
  it("redacts credentials from remote URL when parse fails", async () => {
    const { getGitRemoteUrl } = await import("../datasources/index.js");
    vi.mocked(getGitRemoteUrl).mockResolvedValueOnce(
      "https://user:secret-pat@some-unknown-host.com/repo.git"
    );
    // The real parseAzDevOpsRemoteUrl will return null for this non-Azure URL

    await expect(
      datasource.list({ cwd: "/tmp" }),
    ).rejects.toThrow("***@");
  });

  it("does not include raw credentials in error messages", async () => {
    const { getGitRemoteUrl } = await import("../datasources/index.js");
    vi.mocked(getGitRemoteUrl).mockResolvedValueOnce(
      "https://user:secret-pat@some-unknown-host.com/repo.git"
    );

    try {
      await datasource.list({ cwd: "/tmp" });
    } catch (err) {
      expect(String(err)).not.toContain("secret-pat");
      expect(String(err)).toContain("***@");
    }
  });

  it("redacts credentials in createPullRequest error when no repo matches", async () => {
    const { getGitRemoteUrl } = await import("../datasources/index.js");
    const credUrl = "https://user:my-secret@dev.azure.com/testorg/testproject/_git/nonexistent";
    // getOrgAndProject calls getGitRemoteUrl once, then createPullRequest calls it again
    vi.mocked(getGitRemoteUrl)
      .mockResolvedValueOnce(credUrl)
      .mockResolvedValueOnce(credUrl);
    mockExecFile.mockResolvedValueOnce({ stdout: "refs/remotes/origin/main\n" });
    mockGitApi.getRepositories.mockResolvedValueOnce([]);

    try {
      await datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" });
    } catch (err) {
      expect(String(err)).not.toContain("my-secret");
      expect(String(err)).toContain("***@");
    }
  });
});

describe("azdevops datasource — empty string fallback with || operator", () => {
  it("falls back to parsed orgUrl when opts.org is empty string", async () => {
    // getOrgAndProject uses || instead of ?? so empty string falls back to parsed value
    // Ensure getGitRemoteUrl returns a valid Azure DevOps URL for this test
    const { getGitRemoteUrl } = await import("../datasources/index.js");
    vi.mocked(getGitRemoteUrl).mockResolvedValueOnce(
      "https://dev.azure.com/testorg/testproject/_git/testrepo"
    );
    mockWitApi.queryByWiql.mockResolvedValueOnce({ workItems: [] });

    // Pass empty string for org and project — should fall back to parsed values, not use ""
    const result = await datasource.list({ cwd: "/tmp", org: "", project: "" });

    // Should succeed (not throw) because empty string is treated as falsy
    expect(result).toEqual([]);
  });
});
