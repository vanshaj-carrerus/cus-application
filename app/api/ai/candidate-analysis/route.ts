import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { analyzeCandidate } from "@/lib/services/candidateAnalysisService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { candidateId, force } = (await req.json()) as { candidateId: string; force?: boolean };
  if (!candidateId) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  const analysis = await analyzeCandidate(candidateId, { userId: user.sub, force });
  return NextResponse.json({ analysis });
}, "candidates:write");
