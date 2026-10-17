import { NextResponse } from "next/server";
import {
  isValidFurniture,
  isValidLayoutNamespace,
  loadOfficeFurniture,
  saveOfficeFurniture,
} from "@/lib/office/furnitureStore";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const errorJson = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(request: Request) {
  const namespace = new URL(request.url).searchParams.get("namespace") ?? "";
  if (!isValidLayoutNamespace(namespace)) return errorJson("Invalid namespace.", 400);
  const layout = loadOfficeFurniture(namespace);
  return NextResponse.json(
    { namespace, furniture: layout?.furniture ?? null, updatedAt: layout?.updatedAt ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return errorJson("Layout is too large.", 413);
  let body: { namespace?: unknown; furniture?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return errorJson("Invalid JSON payload.", 400);
  }
  if (!isValidLayoutNamespace(body?.namespace)) return errorJson("Invalid namespace.", 400);
  if (!isValidFurniture(body.furniture)) return errorJson("Invalid furniture payload.", 400);
  const layout = saveOfficeFurniture(body.namespace, body.furniture);
  return NextResponse.json({ ok: true, updatedAt: layout.updatedAt });
}
