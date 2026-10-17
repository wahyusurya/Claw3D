import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@/lib/clawdbot/paths";
import type { FurnitureItem } from "@/features/retro-office/core/types";

// Server copy of each floor's office layout (walls + furniture). The browser keeps its
// localStorage copy as a cache, but this file is the source of truth so a layout survives
// cleared browser storage, private windows and other devices.

type StoredLayout = { furniture: FurnitureItem[]; updatedAt: string };
type FurnitureStore = { schemaVersion: 1; layouts: Record<string, StoredLayout> };

const STORE_DIR = "claw3d";
const STORE_FILE = "office-furniture.json";
export const MAX_FURNITURE_ITEMS = 5000;
const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

export const isValidLayoutNamespace = (value: unknown): value is string =>
  typeof value === "string" && NAMESPACE_RE.test(value);

/** Accept only arrays of plain items with a type and numeric position. */
export const isValidFurniture = (value: unknown): value is FurnitureItem[] =>
  Array.isArray(value) &&
  value.length <= MAX_FURNITURE_ITEMS &&
  value.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as FurnitureItem).type === "string" &&
      Number.isFinite((item as FurnitureItem).x) &&
      Number.isFinite((item as FurnitureItem).y),
  );

const resolveStorePath = () => {
  const dir = path.join(resolveStateDir(), STORE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, STORE_FILE);
};

const readStore = (): FurnitureStore => {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStorePath(), "utf8")) as FurnitureStore;
    if (parsed?.schemaVersion === 1 && parsed.layouts && typeof parsed.layouts === "object") return parsed;
  } catch {
    // missing or unreadable store -> start empty
  }
  return { schemaVersion: 1, layouts: {} };
};

const writeStore = (store: FurnitureStore) => {
  const storePath = resolveStorePath();
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store), "utf8");
  fs.renameSync(tmpPath, storePath); // atomic replace: a crash mid-write never corrupts the store
};

export const loadOfficeFurniture = (namespace: string): StoredLayout | null =>
  readStore().layouts[namespace] ?? null;

export const saveOfficeFurniture = (namespace: string, furniture: FurnitureItem[]): StoredLayout => {
  const store = readStore();
  const layout = { furniture, updatedAt: new Date().toISOString() };
  store.layouts[namespace] = layout;
  writeStore(store);
  return layout;
};
