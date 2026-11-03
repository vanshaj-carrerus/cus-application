import { NextResponse } from "next/server";
import { withHelperAuth } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import { PortalSyncError, failRun, finishRun, progress, saveSection, startRun } from "@/lib/services/portalSyncService";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { candidateId?: string; portal?: string } & (
  | { type: "start" }
  | { type: "progress"; message: string }
  | { type: "section"; section: string; data: unknown }
  | { type: "done" }
  | { type: "error"; message: string }
);

/** What the extension read from the candidate's signed-in browser. A candidate token is pinned to its own candidate. */
export const POST = withHelperAuth(async (req, { user }) => {
  await connectDB();
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.type || !body.portal) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const login = user.role === "CANDIDATE" ? await User.findById(user.sub).select("candidateId") : null;
  const candidateId = user.role === "CANDIDATE" ? (login?.candidateId ? String(login.candidateId) : undefined) : body.candidateId;
  if (!candidateId || !canWorkOnCandidate({ role: user.role, candidateId: login?.candidateId ? String(login.candidateId) : undefined }, candidateId)) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }

  try {
    switch (body.type) {
      case "start":
        await startRun(candidateId, body.portal);
        break;
      case "progress":
        await progress(candidateId, body.portal, String(body.message ?? ""));
        break;
      case "section":
        await saveSection(candidateId, body.portal, body.section, body.data);
        break;
      case "done":
        await finishRun(candidateId, body.portal);
        break;
      case "error":
        await failRun(candidateId, body.portal, String(body.message ?? "Sync failed"));
        break;
      default:
        return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof PortalSyncError) {
      await failRun(candidateId, body.portal, err.message).catch(() => undefined);
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}, "assist:use");
