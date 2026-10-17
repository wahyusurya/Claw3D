// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let stateDir = "";
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw3d-furniture-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});
afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const wall = { _uid: "w1", type: "wall", x: 1126, y: 40, w: 8, h: 640 };
const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/office/furniture/route");
  return PUT(new Request("http://x/api/office/furniture", { method: "PUT", body: JSON.stringify(body) }));
};
const get = async (namespace: string) => {
  const { GET } = await import("@/app/api/office/furniture/route");
  return GET(new Request(`http://x/api/office/furniture?namespace=${encodeURIComponent(namespace)}`));
};

describe("/api/office/furniture", () => {
  it("returns null before anything is saved", async () => {
    const res = await get("hermes-first");
    expect(res.status).toBe(200);
    expect((await res.json()).furniture).toBeNull();
  });

  it("round-trips a layout per floor namespace", async () => {
    expect((await put({ namespace: "hermes-first", furniture: [wall] })).status).toBe(200);
    expect((await (await get("hermes-first")).json()).furniture).toEqual([wall]);
    expect((await (await get("lobby")).json()).furniture).toBeNull(); // floors are independent
    expect(fs.existsSync(path.join(stateDir, "claw3d", "office-furniture.json"))).toBe(true);
  });

  it("rejects bad namespaces and malformed furniture without writing", async () => {
    expect((await put({ namespace: "../etc", furniture: [wall] })).status).toBe(400);
    expect((await put({ namespace: "hermes-first", furniture: [{ type: "wall" }] })).status).toBe(400);
    expect((await put({ namespace: "hermes-first", furniture: "nope" })).status).toBe(400);
    expect((await get("../etc")).status).toBe(400);
    expect(fs.existsSync(path.join(stateDir, "claw3d", "office-furniture.json"))).toBe(false);
  });
});
