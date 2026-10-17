import { NextResponse } from "next/server";
import { isValidProjectSlug, loadActiveProject, saveActiveProject } from "@/lib/office/activeProjectStore";
import { isGitHubRepoAllowed } from "@/lib/office/github";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(loadActiveProject(), { headers: { "Cache-Control": "no-store" } });
}

/** Body: { project: "owner/repo" } to set, { project: null } to clear. */
export async function PUT(request: Request) {
  let body: { project?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  if (body?.project === null) return NextResponse.json(saveActiveProject(null));
  if (!isValidProjectSlug(body?.project)) {
    return NextResponse.json({ error: 'project must be "owner/repo" or null.' }, { status: 400 });
  }
  if (!isGitHubRepoAllowed(body.project)) {
    return NextResponse.json({ error: `${body.project} is outside the allowed GitHub owners.` }, { status: 400 });
  }
  return NextResponse.json(saveActiveProject(body.project));
}
