import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

import { datasource, detectWorkItemType } from "../datasources/azdevops.js";

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
  it("updates state to Closed", async () => {
    mockExecFile.mockResolvedValue({ stdout: "" });

    await datasource.close("42", { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "az",
      expect.arrayContaining(["boards", "work-item", "update", "--id", "42", "--state", "Closed"]),
      { cwd: "/tmp" },
    );
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

describe("azdevops datasource — getUsername", () => {
  it("returns slugified git config user.name when available", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "Alice Smith\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("alice-smith");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to az account show user.name when git config fails", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockResolvedValueOnce({ stdout: "Bob Jones\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("bob-jones");
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to az account show user.name when git config returns empty", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "\n" });
    mockExecFile.mockResolvedValueOnce({ stdout: "Bob Jones\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("bob-jones");
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to az account show user.principalName email prefix", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockRejectedValueOnce(new Error("az user.name failed"));
    mockExecFile.mockResolvedValueOnce({ stdout: "john@corp.com\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("john");
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("returns unknown when all fallbacks fail", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockRejectedValueOnce(new Error("az user.name failed"));
    mockExecFile.mockRejectedValueOnce(new Error("az principalName failed"));

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("unknown");
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("skips empty az account show user.name and tries principalName", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockResolvedValueOnce({ stdout: "\n" });
    mockExecFile.mockResolvedValueOnce({ stdout: "alice@example.com\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("alice");
    expect(mockExecFile).toHaveBeenCalledTimes(3);
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

describe("azdevops datasource — getUsername", () => {
  it("returns slugified git username when git config succeeds", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "John Doe\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("john-doe");
  });

  it("falls back to az account show user.name when git config fails", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockResolvedValueOnce({ stdout: "Jane Smith\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("jane-smith");
  });

  it("falls back to az principalName when git config and user.name both fail", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockRejectedValueOnce(new Error("user.name not available"));
    mockExecFile.mockResolvedValueOnce({ stdout: "john@corp.com\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("john");
  });

  it("returns 'unknown' when all sources fail", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git config not set"));
    mockExecFile.mockRejectedValueOnce(new Error("az not found"));
    mockExecFile.mockRejectedValueOnce(new Error("az not found"));

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("unknown");
  });

  it("falls through to az fallback when git config returns empty string", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: "\n" });
    mockExecFile.mockResolvedValueOnce({ stdout: "CI Service Account\n" });

    const result = await datasource.getUsername({ cwd: "/tmp" });

    expect(result).toBe("ci-service-account");
  });
});
