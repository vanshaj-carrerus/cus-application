import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { bulkMatchCandidatesToJob } from "@/lib/services/matchingService";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { jobId, candidateIds, limit } = (await req.json()) as { jobId: string; candidateIds?: string[]; limit?: number };
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  let ids = candidateIds;
  if (!ids?.length) {
    await connectDB();
    const candidates = await Candidate.find({}).select("_id").limit(limit ?? 25);
    ids = candidates.map((c) => String(c._id));
  }

  const matches = await bulkMatchCandidatesToJob(jobId, ids, { userId: user.sub });
  return NextResponse.json({ matches, count: matches.length });
}, "matching:write");
