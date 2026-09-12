import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";

export const GET = withAuth(async (_req: NextRequest, { params, user }) => {
  await connectDB();
  const application = await Application.findById(params.id).populate("candidateId").populate("jobId").populate("resumeVersionId");
  if (!application) return NextResponse.json({ error: "Application not found" }, { status: 404 });

  // Same ownership check as the list route — a candidate must never be able to
  // read another candidate's application just by guessing/enumerating an id.
  if (user.role === "CANDIDATE" && String(application.candidateId._id ?? application.candidateId) !== user.candidateId) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  return NextResponse.json({ application });
}, "applications:read");

export const PATCH = withAuth(async (req: NextRequest, { params, user }) => {
  await connectDB();
  const body = (await req.json()) as { status?: string; note?: string; [key: string]: unknown };
  const application = await Application.findById(params.id);
  if (!application) return NextResponse.json({ error: "Application not found" }, { status: 404 });

  if (body.status && body.status !== application.status) {
    application.status = body.status as typeof application.status;
    application.timeline.push({
      status: application.status,
      note: body.note,
      changedBy: user.sub as unknown as never,
      changedAt: new Date(),
    });
  }

  const { status: _status, note: _note, ...rest } = body;
  void _status;
  void _note;
  Object.assign(application, rest);

  await application.save();
  return NextResponse.json({ application });
}, "applications:write");
