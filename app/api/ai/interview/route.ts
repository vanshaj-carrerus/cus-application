import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { generateInterviewQuestions, summarizeInterview } from "@/lib/services/interviewService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const body = (await req.json()) as {
    mode: "QUESTIONS" | "SUMMARY";
    jobId?: string;
    candidateId?: string;
    interviewId?: string;
    notes?: string;
  };

  if (body.mode === "SUMMARY") {
    if (!body.interviewId || !body.notes) {
      return NextResponse.json({ error: "interviewId and notes are required for SUMMARY mode" }, { status: 400 });
    }
    const summary = await summarizeInterview(body.interviewId, body.notes, { userId: user.sub });
    return NextResponse.json({ summary });
  }

  if (!body.jobId) return NextResponse.json({ error: "jobId is required for QUESTIONS mode" }, { status: 400 });
  const questions = await generateInterviewQuestions(body.jobId, body.candidateId, { userId: user.sub });
  return NextResponse.json({ questions });
}, "candidates:read");
