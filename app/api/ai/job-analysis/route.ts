import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { analyzeJob } from "@/lib/services/jobAnalysisService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { jobId, force } = (await req.json()) as { jobId: string; force?: boolean };
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  const analysis = await analyzeJob(jobId, { userId: user.sub, force });
  return NextResponse.json({ analysis });
}, "jobs:write");
