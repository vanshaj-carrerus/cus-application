import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import type { SessionPayload } from "@/lib/auth/session";
import { PortalConnectionError, listConnections, saveConnection } from "@/lib/services/portalConnectionService";

/** Staff pass candidateId; a candidate login is always pinned to its own id from the session. */
function resolveCandidateId(user: SessionPayload, requested: unknown): string | null {
  const id = user.role === "CANDIDATE" ? user.candidateId : typeof requested === "string" ? requested : undefined;
  if (!id || !canWorkOnCandidate(user, id)) return null;
  return id;
}

export const GET = withAuth(async (req: NextRequest, { user }) => {
  const candidateId = resolveCandidateId(user, req.nextUrl.searchParams.get("candidateId"));
  if (!candidateId) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  await connectDB();
  return NextResponse.json({ connections: await listConnections(candidateId) });
}, "assist:use");

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const body = await req.json().catch(() => ({}));
  const candidateId = resolveCandidateId(user, body.candidateId);
  if (!candidateId) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  await connectDB();
  try {
    return NextResponse.json({ connection: await saveConnection(candidateId, user.sub, body) }, { status: 201 });
  } catch (err) {
    if (err instanceof PortalConnectionError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}, "assist:use");
