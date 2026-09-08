import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { analyzeResumeQuality } from "@/lib/services/resumeService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { resumeId } = (await req.json()) as { resumeId: string };
  if (!resumeId) return NextResponse.json({ error: "resumeId is required" }, { status: 400 });
  const result = await analyzeResumeQuality(resumeId, { userId: user.sub });
  return NextResponse.json({ result });
}, "resumes:write");
