import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { tailorResume } from "@/lib/services/resumeService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { candidateId, jobId } = (await req.json()) as { candidateId: string; jobId: string };
  if (!candidateId || !jobId) return NextResponse.json({ error: "candidateId and jobId are required" }, { status: 400 });
  const resume = await tailorResume(candidateId, jobId, { userId: user.sub });
  return NextResponse.json({ resume });
}, "resumes:write");
