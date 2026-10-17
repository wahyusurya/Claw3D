import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@/lib/clawdbot/paths";

// The project the office team is currently working on (GitHub "owner/repo"), or null.
// It scopes the GitHub review, the meeting cards and the Kanban board to that one project.

const STORE_DIR = "claw3d";
const STORE_FILE = "active-project.json";
const REPO_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export type ActiveProject = { project: string | null; updatedAt: string | null };

export const isValidProjectSlug = (value: unknown): value is string =>
  typeof value === "string" && REPO_SLUG_RE.test(value);

const resolveStorePath = () => {
  const dir = path.join(resolveStateDir(), STORE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, STORE_FILE);
};

export const loadActiveProject = (): ActiveProject => {
  try {
    const data = JSON.parse(fs.readFileSync(resolveStorePath(), "utf8"));
    return {
      project: isValidProjectSlug(data?.project) ? data.project : null,
      updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : null,
    };
  } catch {
    return { project: null, updatedAt: null };
  }
};

export const saveActiveProject = (project: string | null): ActiveProject => {
  const value = { project, updatedAt: new Date().toISOString() };
  const storePath = resolveStorePath();
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value), "utf8");
  fs.renameSync(tmpPath, storePath);
  return value;
};
