import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { AnswerError, deleteAnswer, updateAnswer } from "@/lib/services/savedAnswerService";

export const PATCH = withAuth(async (req: NextRequest, { params }) => {
  await connectDB();
  try {
    return NextResponse.json({ answer: await updateAnswer(params.id, params.answerId, await req.json().catch(() => ({})), "STAFF") });
  } catch (err) {
    if (err instanceof AnswerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}, "candidates:write");

export const DELETE = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  try {
    await deleteAnswer(params.id, params.answerId);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (err instanceof AnswerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}, "candidates:write");
