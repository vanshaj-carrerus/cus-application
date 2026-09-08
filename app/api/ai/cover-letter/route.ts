import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { generateCoverLetter } from "@/lib/services/coverLetterService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { candidateId, jobId, tone } = (await req.json()) as {
    candidateId: string;
    jobId: string;
    tone?: "PROFESSIONAL" | "FRIENDLY" | "SHORT" | "FORMAL";
  };
  if (!candidateId || !jobId) return NextResponse.json({ error: "candidateId and jobId are required" }, { status: 400 });
  const coverLetter = await generateCoverLetter(candidateId, jobId, { tone, userId: user.sub });
  return NextResponse.json({ coverLetter });
}, "resumes:write");
