import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

import { datasource, detectWorkItemType, detectDoneState } from "../datasources/azdevops.js";

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("azdevops datasource — list", () => {
  it("queries work items and fetches details", async () => {
    // First call: az boards query
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 1 }, { id: 2 }]),
    });
    // Second call: fetch item 1
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 1,
        fields: { "System.Title": "Bug", "System.Description": "fix", "System.Tags": "bug", "System.State": "Active" },
        _links: { html: { href: "https://dev.azure.com/1" } },
      }),
    });
    // Third call: fetchComments for item 1
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({ comments: [] }),
    });
    // Fourth call: fetch item 2
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 2,
        fields: { "System.Title": "Feature", "System.Description": "add", "System.Tags": "", "System.State": "New" },
        url: "https://dev.azure.com/2",
      }),
    });
    // Fifth call: fetchComments for item 2
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({ comments: [] }),
    });

    const result = await datasource.list({ cwd: "/tmp" });

    expect(result).toHaveLength(2);
    expect(result[0].number).toBe("1");
    expect(result[0].title).toBe("Bug");
    expect(result[1].number).toBe("2");
  });

  it("passes org and project to az command", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: JSON.stringify([]) });

    await datasource.list({ cwd: "/tmp", org: "https://dev.azure.com/myorg", project: "MyProj" });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--org");
    expect(args).toContain("https://dev.azure.com/myorg");
    expect(args).toContain("--project");
    expect(args).toContain("MyProj");
  });

  it("throws descriptive error when az returns non-JSON output", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Not Found\n" });

    await expect(datasource.list({ cwd: "/tmp" })).rejects.toThrow(
      "Failed to parse Azure CLI output"
    );
  });
});

describe("azdevops datasource — fetch", () => {
  it("returns issue details", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 42,
        fields: {
          "System.Title": "Auth bug",
          "System.Description": "login broken",
          "System.Tags": "bug;critical",
          "System.State": "Active",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "must fix",
        },
        _links: { html: { href: "https://dev.azure.com/42" } },
      }),
    });
    // fetchComments
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        comments: [{ text: "looking into it", createdBy: { displayName: "Alice" } }],
      }),
    });

    const result = await datasource.fetch("42", { cwd: "/tmp" });

    expect(result.number).toBe("42");
    expect(result.title).toBe("Auth bug");
    expect(result.labels).toEqual(["bug", "critical"]);
    expect(result.comments).toEqual(["**Alice:** looking into it"]);
    expect(result.acceptanceCriteria).toBe("must fix");
  });

  it("handles fetch with org and project", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 1, fields: {} }),
    });
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({ comments: [] }),
    });

    await datasource.fetch("1", { cwd: "/tmp", org: "org-url", project: "proj" });

    const fetchArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(fetchArgs).toContain("--org");
    expect(fetchArgs).toContain("org-url");
  });

  it("returns empty comments when fetchComments fails", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 1, fields: { "System.Title": "T" } }),
    });
    mockExecFile.mockRejectedValueOnce(new Error("comment fetch failed"));

    const result = await datasource.fetch("1", { cwd: "/tmp" });

    expect(result.comments).toEqual([]);
  });

  it("throws descriptive error when az returns non-JSON output", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "ERROR: auth required\n" });

    await expect(datasource.fetch("42", { cwd: "/tmp" })).rejects.toThrow(
      "Failed to parse Azure CLI output"
    );
  });
});

describe("azdevops datasource — update", () => {
  it("calls az boards work-item update", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.update("42", "New Title", "New Body", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "az",
      expect.arrayContaining(["boards", "work-item", "update", "--id", "42", "--title", "New Title"]),
      { cwd: "/tmp" },
    );
  });

  it("passes org and project when provided", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.update("1", "T", "B", { cwd: "/tmp", org: "org-url", project: "proj" });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--org");
    expect(args).toContain("--project");
  });
});

describe("azdevops datasource — close", () => {
  it("detects done state dynamically via work item type", async () => {
    // 1st call: az boards work-item show (fetch work item to get type)
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 42,
        fields: { "System.WorkItemType": "User Story" },
      }),
    });
    // 2nd call: az boards work-item type state list (detect done state)
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New", category: "Proposed" },
        { name: "Active", category: "InProgress" },
        { name: "Closed", category: "Completed" },
      ]),
    });
    // 3rd call: az boards work-item update
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp", org: "close-org1", project: "close-proj1" });

    // Verify the update used the detected state
    const updateArgs = mockExecFile.mock.calls[2][1] as string[];
    expect(updateArgs).toEqual(
      expect.arrayContaining(["boards", "work-item", "update", "--id", "42", "--state", "Closed"]),
    );
  });

  it("resolves to Done for Scrum process template", async () => {
    // 1st call: az boards work-item show (fetch work item to get type)
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 42,
        fields: { "System.WorkItemType": "Product Backlog Item" },
      }),
    });
    // 2nd call: az boards work-item type state list (detect done state)
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New", category: "Proposed" },
        { name: "Approved", category: "InProgress" },
        { name: "Committed", category: "InProgress" },
        { name: "Done", category: "Completed" },
      ]),
    });
    // 3rd call: az boards work-item update
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp", org: "scrum-org", project: "scrum-proj" });

    // Verify the update used "Done" (Scrum terminal state)
    const updateArgs = mockExecFile.mock.calls[2][1] as string[];
    expect(updateArgs).toEqual(
      expect.arrayContaining(["boards", "work-item", "update", "--id", "42", "--state", "Done"]),
    );
  });

  it("uses opts.workItemType to skip fetching work item", async () => {
    // 1st call: az boards work-item type state list
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New", category: "Proposed" },
        { name: "Done", category: "Completed" },
      ]),
    });
    // 2nd call: az boards work-item update
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp", workItemType: "Product Backlog Item", org: "close-org2", project: "close-proj2" });

    // Should NOT have called work-item show — only 2 exec calls
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const updateArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(updateArgs).toEqual(
      expect.arrayContaining(["--state", "Done"]),
    );
  });

  it("falls back to Closed when state detection fails", async () => {
    // 1st call: az boards work-item show
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 42,
        fields: { "System.WorkItemType": "Bug" },
      }),
    });
    // 2nd call: az boards work-item type state list — fails
    mockExecFile.mockRejectedValueOnce(new Error("az error"));
    // 3rd call: az boards work-item update
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp", org: "close-org3", project: "close-proj3" });

    const updateArgs = mockExecFile.mock.calls[2][1] as string[];
    expect(updateArgs).toEqual(
      expect.arrayContaining(["--state", "Closed"]),
    );
  });

  it("falls back to Closed when work item has no type", async () => {
    // 1st call: az boards work-item show — returns item without type
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 42, fields: {} }),
    });
    // 2nd call: az boards work-item update (should use "Closed" default)
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp", org: "close-org4", project: "close-proj4" });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const updateArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(updateArgs).toEqual(
      expect.arrayContaining(["--state", "Closed"]),
    );
  });

  it("passes org and project when provided", async () => {
    // 1st call: work-item show
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 42,
        fields: { "System.WorkItemType": "User Story" },
      }),
    });
    // 2nd call: state list
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Closed", category: "Completed" },
      ]),
    });
    // 3rd call: update
    mockExecFile.mockResolvedValueOnce({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp", org: "close-org5", project: "close-proj5" });

    const showArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(showArgs).toContain("--org");
    expect(showArgs).toContain("close-org5");
    expect(showArgs).toContain("--project");
    expect(showArgs).toContain("close-proj5");

    const updateArgs = mockExecFile.mock.calls[2][1] as string[];
    expect(updateArgs).toContain("--org");
    expect(updateArgs).toContain("--project");
  });
});

describe("azdevops datasource — create", () => {
  it("creates a work item using detected type when workItemType not provided", async () => {
    // First call: detectWorkItemType
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([{ name: "User Story" }, { name: "Bug" }]),
    });
    // Second call: az boards work-item create
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 99,
        fields: {
          "System.Title": "New Item",
          "System.Description": "desc",
          "System.Tags": "",
          "System.State": "New",
        },
        _links: { html: { href: "https://dev.azure.com/99" } },
      }),
    });

    const result = await datasource.create("New Item", "desc", { cwd: "/tmp" });

    expect(result.number).toBe("99");
    expect(result.title).toBe("New Item");
    expect(result.state).toBe("New");
    // Verify the create call used the detected type
    const createArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(createArgs).toContain("--type");
    expect(createArgs[createArgs.indexOf("--type") + 1]).toBe("User Story");
  });

  it("uses opts.workItemType when provided", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 100,
        fields: {
          "System.Title": "Item",
          "System.Description": "body",
          "System.Tags": "",
          "System.State": "New",
        },
        _links: { html: { href: "https://dev.azure.com/100" } },
      }),
    });

    const result = await datasource.create("Item", "body", {
      cwd: "/tmp",
      workItemType: "Product Backlog Item",
    });

    expect(result.number).toBe("100");
    // Should NOT have called detectWorkItemType — only one exec call (the create)
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const createArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(createArgs[createArgs.indexOf("--type") + 1]).toBe("Product Backlog Item");
  });

  it("throws descriptive error when type cannot be determined", async () => {
    // detectWorkItemType fails
    mockExecFile.mockRejectedValueOnce(new Error("az not found"));

    await expect(
      datasource.create("Title", "Body", { cwd: "/tmp" }),
    ).rejects.toThrow("Could not determine work item type");
  });

  it("throws descriptive error when az returns non-JSON output", async () => {
    // First call: detectWorkItemType succeeds
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([{ name: "User Story" }]),
    });
    // Second call: az boards work-item create returns non-JSON
    mockExecFile.mockResolvedValueOnce({ stdout: "ERROR: not authorized\n" });

    await expect(
      datasource.create("Title", "Body", { cwd: "/tmp" })
    ).rejects.toThrow("Failed to parse Azure CLI output");
  });
});

describe("detectWorkItemType", () => {
  it("returns 'User Story' when available", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Bug" },
        { name: "User Story" },
        { name: "Task" },
      ]),
    });

    const result = await detectWorkItemType({ cwd: "/tmp", org: "org-url", project: "proj" });

    expect(result).toBe("User Story");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--project");
    expect(args).toContain("proj");
    expect(args).toContain("--org");
    expect(args).toContain("org-url");
  });

  it("returns 'Product Backlog Item' for Scrum template", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Bug" },
        { name: "Product Backlog Item" },
        { name: "Task" },
      ]),
    });

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Product Backlog Item");
  });

  it("returns 'Requirement' for CMMI template", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Bug" },
        { name: "Requirement" },
        { name: "Task" },
      ]),
    });

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Requirement");
  });

  it("returns 'Issue' when no higher-priority types exist", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Bug" },
        { name: "Issue" },
        { name: "Task" },
      ]),
    });

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Issue");
  });

  it("falls back to first type when no preferred types match", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Custom Item" },
        { name: "Task" },
      ]),
    });

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBe("Custom Item");
  });

  it("returns null on failure", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("az not found"));

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBeNull();
  });

  it("returns null for empty type list", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([]),
    });

    const result = await detectWorkItemType({ cwd: "/tmp" });
    expect(result).toBeNull();
  });
});

describe("detectDoneState", () => {
  it("returns the state with Completed category", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New", category: "Proposed" },
        { name: "Active", category: "InProgress" },
        { name: "Done", category: "Completed" },
      ]),
    });

    const result = await detectDoneState("Product Backlog Item", {
      cwd: "/tmp",
      org: "org1",
      project: "proj1",
    });

    expect(result).toBe("Done");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--type");
    expect(args[args.indexOf("--type") + 1]).toBe("Product Backlog Item");
    expect(args).toContain("--project");
    expect(args).toContain("--org");
  });

  it("returns Closed when category is Completed for Agile template", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New", category: "Proposed" },
        { name: "Active", category: "InProgress" },
        { name: "Closed", category: "Completed" },
      ]),
    });

    const result = await detectDoneState("User Story", {
      cwd: "/tmp",
      org: "org2",
      project: "proj2",
    });

    expect(result).toBe("Closed");
  });

  it("falls back to Done when no Completed category exists", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New" },
        { name: "Active" },
        { name: "Done" },
      ]),
    });

    const result = await detectDoneState("Product Backlog Item", {
      cwd: "/tmp",
      org: "org3",
      project: "proj3",
    });

    expect(result).toBe("Done");
  });

  it("falls back to Closed when Done is not available", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New" },
        { name: "Active" },
        { name: "Closed" },
      ]),
    });

    const result = await detectDoneState("User Story", {
      cwd: "/tmp",
      org: "org4",
      project: "proj4",
    });

    expect(result).toBe("Closed");
  });

  it("falls back to Resolved when Done and Closed are not available", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New" },
        { name: "Active" },
        { name: "Resolved" },
      ]),
    });

    const result = await detectDoneState("Requirement", {
      cwd: "/tmp",
      org: "org5",
      project: "proj5",
    });

    expect(result).toBe("Resolved");
  });

  it("falls back to Completed when only Completed state exists", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New" },
        { name: "Active" },
        { name: "Completed" },
      ]),
    });

    const result = await detectDoneState("Custom Item", {
      cwd: "/tmp",
      org: "org6",
      project: "proj6",
    });

    expect(result).toBe("Completed");
  });

  it("defaults to Closed when no known terminal states exist", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "New" },
        { name: "Active" },
        { name: "Custom Final" },
      ]),
    });

    const result = await detectDoneState("Custom Item", {
      cwd: "/tmp",
      org: "org7",
      project: "proj7",
    });

    expect(result).toBe("Closed");
  });

  it("defaults to Closed on CLI error", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("az not found"));

    const result = await detectDoneState("User Story", {
      cwd: "/tmp",
      org: "org8",
      project: "proj8",
    });

    expect(result).toBe("Closed");
  });

  it("returns cached result on subsequent calls", async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "Done", category: "Completed" },
      ]),
    });

    const first = await detectDoneState("PBI", {
      cwd: "/tmp",
      org: "cached-org",
      project: "cached-proj",
    });
    const second = await detectDoneState("PBI", {
      cwd: "/tmp",
      org: "cached-org",
      project: "cached-proj",
    });

    expect(first).toBe("Done");
    expect(second).toBe("Done");
    // Only one CLI call should have been made
    expect(mockExecFile).toHaveBeenCalledTimes(1);
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
});

describe("azdevops datasource — buildBranchName", () => {
  it("builds <username>/dispatch/<number>-<slug>", () => {
    const result = datasource.buildBranchName("42", "Add Auth Feature", "testuser");
    expect(result).toBe("testuser/dispatch/42-add-auth-feature");
  });
});

describe("azdevops datasource — createAndSwitchBranch", () => {
  it("creates new branch", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git", ["checkout", "-b", "dispatch/42-feat"], { cwd: "/tmp" },
    );
  });

  it("falls back to checkout if already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ stdout: "" });

    await datasource.createAndSwitchBranch("dispatch/42-feat", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
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
    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/tmp" });
  });
});

describe("azdevops datasource — pushBranch", () => {
  it("calls git push with upstream", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });
    await datasource.pushBranch("dispatch/42-feat", { cwd: "/tmp" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git", ["push", "--set-upstream", "origin", "dispatch/42-feat"], { cwd: "/tmp" },
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
  it("creates PR and returns URL", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({ url: "https://dev.azure.com/pr/1" }),
    });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://dev.azure.com/pr/1");
  });

  it("returns existing PR URL when already exists", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ url: "https://dev.azure.com/pr/5" }]),
      });

    const url = await datasource.createPullRequest(
      "dispatch/42-feat", "42", "Title", "Body", { cwd: "/tmp" },
    );

    expect(url).toBe("https://dev.azure.com/pr/5");
  });

  it("returns empty string when existing PR list is empty", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) });

    const url = await datasource.createPullRequest(
      "b", "1", "T", "B", { cwd: "/tmp" },
    );

    expect(url).toBe("");
  });

  it("throws for non-already-exists errors", async () => {
    mockExecFile.mockRejectedValue(new Error("auth required"));

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" }),
    ).rejects.toThrow("auth required");
  });

  it("throws descriptive error when pr create returns non-JSON output", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "ERROR: server error\n" });

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" })
    ).rejects.toThrow("Failed to parse Azure CLI output");
  });

  it("throws descriptive error when pr list returns non-JSON output in catch branch", async () => {
    // First call: pr create rejects with "already exists" to trigger catch path
    mockExecFile.mockRejectedValueOnce(new Error("already exists"));
    // Second call: pr list returns non-JSON
    mockExecFile.mockResolvedValueOnce({ stdout: "unexpected output\n" });

    await expect(
      datasource.createPullRequest("b", "1", "T", "B", { cwd: "/tmp" })
    ).rejects.toThrow("Failed to parse Azure CLI output");
  });
});
