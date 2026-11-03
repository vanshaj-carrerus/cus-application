import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { AnswerError, createAnswer, listAnswers } from "@/lib/services/savedAnswerService";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  return NextResponse.json({ answers: await listAnswers(params.id) });
}, "candidates:read");

export const POST = withAuth(async (req: NextRequest, { params }) => {
  await connectDB();
  try {
    const answer = await createAnswer(params.id, await req.json().catch(() => ({})), "STAFF");
    return NextResponse.json({ answer }, { status: 201 });
  } catch (err) {
    if (err instanceof AnswerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}, "candidates:write");
