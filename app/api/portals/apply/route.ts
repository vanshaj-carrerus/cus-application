import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import { requestStop } from "@/lib/services/portalApplyService";

/** Stop an auto-apply run. The extension ends it after the job it is on. A candidate login can only stop its own. */
export const POST = withAuth(async (req: NextRequest, { user }) => {
  const body = (await req.json().catch(() => ({}))) as { candidateId?: string; portal?: string; action?: string };
  const candidateId = user.role === "CANDIDATE" ? user.candidateId : body.candidateId;
  if (!candidateId || !body.portal || body.action !== "stop" || !canWorkOnCandidate(user, candidateId)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  await connectDB();
  await requestStop(candidateId, body.portal);
  return NextResponse.json({ ok: true });
}, "assist:use");
