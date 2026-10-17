// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command !== "gh") return { status: 1, stdout: "", stderr: "not a git repo" };
    if (args[0] === "--version") return { status: 0, stdout: "gh version test", stderr: "" };
    if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "wahyusurya\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "search") {
      const pr = (repo: string, number: number) => ({ number, title: `pr ${number}`, url: `https://github.com/${repo}/pull/${number}`,
        author: { login: "wahyusurya" }, repository: { nameWithOwner: repo }, updatedAt: "2026-10-17T00:00:00Z", isDraft: false, labels: [] });
      return { status: 0, stdout: JSON.stringify([pr("wahyusurya/Claw3D", 1), pr("other-org/private-repo", 2)]), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let stateDir = "";
const setActiveProject = (project: string | null) => {
  fs.mkdirSync(path.join(stateDir, "claw3d"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "claw3d", "active-project.json"), JSON.stringify({ project }));
};

describe("STUDIO_GITHUB_OWNERS allowlist", () => {
  beforeEach(() => {
    calls.length = 0;
    process.env.STUDIO_GITHUB_OWNERS = "wahyusurya";
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw3d-gh-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setActiveProject("wahyusurya/Claw3D");
  });
  afterEach(() => {
    delete process.env.STUDIO_GITHUB_OWNERS;
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns nothing to review when there is no active project", async () => {
    setActiveProject(null);
    const { loadGitHubDashboard } = await import("@/lib/office/github");
    const dashboard = loadGitHubDashboard();
    expect(dashboard.reviewRequests).toEqual([]);
    expect(dashboard.authoredPullRequests).toEqual([]);
    expect(dashboard.message).toMatch(/No active project/);
    expect(calls.some((call) => call[1] === "search")).toBe(false);
  });

  it("scopes searches to the active project repo", async () => {
    const { loadGitHubDashboard } = await import("@/lib/office/github");
    loadGitHubDashboard();
    const searches = calls.filter((call) => call[1] === "search");
    expect(searches.length).toBe(2);
    for (const search of searches) expect(search.join(" ")).toContain("--repo wahyusurya/Claw3D");
  });

  it("scopes searches to allowed owners and drops other repos", async () => {
    const { loadGitHubDashboard } = await import("@/lib/office/github");
    const dashboard = loadGitHubDashboard();
    expect(dashboard.reviewRequests.map((pr) => pr.repo)).toEqual(["wahyusurya/Claw3D"]);
    expect(dashboard.authoredPullRequests.map((pr) => pr.repo)).toEqual(["wahyusurya/Claw3D"]);
    const searches = calls.filter((call) => call[1] === "search");
    expect(searches.length).toBe(2);
    for (const search of searches) expect(search.join(" ")).toContain("--owner wahyusurya");
  });

  it("refuses reviews on repos outside the allowlist before running gh", async () => {
    const { submitGitHubPullRequestReview, loadGitHubPullRequestDetail } = await import("@/lib/office/github");
    expect(() => submitGitHubPullRequestReview({ repo: "other-org/private-repo", number: 2, action: "APPROVE" }))
      .toThrow(/outside the allowed GitHub owners/);
    expect(() => loadGitHubPullRequestDetail({ repo: "other-org/private-repo", number: 2 }))
      .toThrow(/outside the allowed GitHub owners/);
    expect(calls.some((call) => call.includes("review") || call.includes("diff"))).toBe(false);
  });

  it("allows everything when the allowlist is empty (upstream default)", async () => {
    delete process.env.STUDIO_GITHUB_OWNERS;
    const { isGitHubRepoAllowed } = await import("@/lib/office/github");
    expect(isGitHubRepoAllowed("other-org/private-repo")).toBe(true);
    process.env.STUDIO_GITHUB_OWNERS = "WahyuSurya";
    expect(isGitHubRepoAllowed("wahyusurya/claw3d")).toBe(true);
    expect(isGitHubRepoAllowed("other-org/private-repo")).toBe(false);
  });
});
