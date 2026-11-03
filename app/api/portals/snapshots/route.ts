import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import { getSnapshot } from "@/lib/services/portalSyncService";

/** What was last read from the candidate's portal account. A candidate login only ever gets its own. */
export const GET = withAuth(async (req: NextRequest, { user }) => {
  const portal = req.nextUrl.searchParams.get("portal");
  const requested = req.nextUrl.searchParams.get("candidateId");
  const candidateId = user.role === "CANDIDATE" ? user.candidateId : requested;
  if (!portal || !candidateId || !canWorkOnCandidate(user, candidateId)) return NextResponse.json({ error: "portal and candidateId are required" }, { status: 400 });
  await connectDB();
  return NextResponse.json(await getSnapshot(candidateId, portal));
}, "assist:use");
