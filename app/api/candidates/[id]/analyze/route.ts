import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { analyzeCandidate } from "@/lib/services/candidateAnalysisService";

export const POST = withAuth(async (req: NextRequest, { params, user }) => {
  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const analysis = await analyzeCandidate(params.id, { userId: user.sub, force: body.force });
  return NextResponse.json({ analysis });
}, "candidates:write");
