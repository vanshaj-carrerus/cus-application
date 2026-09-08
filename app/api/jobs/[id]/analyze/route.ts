import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { analyzeJob } from "@/lib/services/jobAnalysisService";
import { predictJobDifficulty } from "@/lib/services/jobDifficultyService";

export const POST = withAuth(async (req: NextRequest, { params, user }) => {
  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const analysis = await analyzeJob(params.id, { userId: user.sub, force: body.force });
  const difficulty = await predictJobDifficulty(params.id, { userId: user.sub });
  return NextResponse.json({ analysis, difficulty });
}, "jobs:write");
