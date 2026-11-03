import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { AnswerError, deleteAnswer, updateAnswer } from "@/lib/services/savedAnswerService";

function candidateOnly(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  return null;
}

export const PATCH = withAuth(async (req: NextRequest, { user, params }) => {
  const denied = candidateOnly(user);
  if (denied) return denied;
  await connectDB();
  try {
    return NextResponse.json({ answer: await updateAnswer(user.candidateId!, params.answerId, await req.json().catch(() => ({})), "CANDIDATE") });
  } catch (err) {
    if (err instanceof AnswerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

export const DELETE = withAuth(async (_req: NextRequest, { user, params }) => {
  const denied = candidateOnly(user);
  if (denied) return denied;
  await connectDB();
  try {
    await deleteAnswer(user.candidateId!, params.answerId);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (err instanceof AnswerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
