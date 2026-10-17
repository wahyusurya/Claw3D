// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let stateDir = "";
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw3d-project-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.STUDIO_GITHUB_OWNERS = "wahyusurya";
});
afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.STUDIO_GITHUB_OWNERS;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/office/project/route");
  return PUT(new Request("http://x/api/office/project", { method: "PUT", body: JSON.stringify(body) }));
};
const get = async () => {
  const { GET } = await import("@/app/api/office/project/route");
  return (await GET()).json();
};

describe("/api/office/project", () => {
  it("starts with no active project", async () => {
    expect((await get()).project).toBeNull();
  });

  it("sets and clears the active project", async () => {
    expect((await put({ project: "wahyusurya/konveksi" })).status).toBe(200);
    expect((await get()).project).toBe("wahyusurya/konveksi");
    expect((await put({ project: null })).status).toBe(200);
    expect((await get()).project).toBeNull();
  });

  it("rejects malformed slugs and repos outside the allowed owners", async () => {
    expect((await put({ project: "not a repo" })).status).toBe(400);
    expect((await put({ project: "../etc/passwd" })).status).toBe(400);
    expect((await put({ project: "someone-else/repo" })).status).toBe(400);
    expect((await get()).project).toBeNull();
  });
});
