import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { matchCandidateToJob } from "@/lib/services/matchingService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { candidateId, jobId, force } = (await req.json()) as { candidateId: string; jobId: string; force?: boolean };
  if (!candidateId || !jobId) return NextResponse.json({ error: "candidateId and jobId are required" }, { status: 400 });
  const match = await matchCandidateToJob(candidateId, jobId, { userId: user.sub, force });
  return NextResponse.json({ match });
}, "matching:write");
