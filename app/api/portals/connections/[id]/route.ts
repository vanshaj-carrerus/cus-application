import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import { PortalConnection } from "@/lib/models/PortalConnection";
import { PortalConnectionError, removeConnection } from "@/lib/services/portalConnectionService";

export const DELETE = withAuth(async (_req: NextRequest, { user, params }) => {
  await connectDB();
  const row = await PortalConnection.findById(params.id).select("candidateId");
  if (!row || !canWorkOnCandidate(user, row.candidateId)) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  try {
    await removeConnection(String(row.candidateId), params.id);
  } catch (err) {
    if (err instanceof PortalConnectionError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return NextResponse.json({ ok: true });
}, "assist:use");
