import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { AnswerError, createAnswer, listAnswers } from "@/lib/services/savedAnswerService";

function candidateOnly(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  return null;
}

export const GET = withAuth(async (_req: NextRequest, { user }) => {
  const denied = candidateOnly(user);
  if (denied) return denied;
  await connectDB();
  return NextResponse.json({ answers: await listAnswers(user.candidateId!) });
});

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const denied = candidateOnly(user);
  if (denied) return denied;
  await connectDB();
  try {
    return NextResponse.json({ answer: await createAnswer(user.candidateId!, await req.json().catch(() => ({})), "CANDIDATE") }, { status: 201 });
  } catch (err) {
    if (err instanceof AnswerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
