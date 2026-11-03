import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { withHelperAuth } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Resume } from "@/lib/models/Resume";
import { materializeStoredFile } from "@/lib/storage/fileStorage";

export const runtime = "nodejs";

/** The tailored resume PDF for an application this marketer has open. */
export const GET = withHelperAuth(async (_req, { params, user }) => {
  await connectDB();
  const application = await Application.findOne({ _id: params.id, automationStatus: "IN_PROGRESS", "assist.requestedBy": user.sub }).select("resumeVersionId");
  if (!application?.resumeVersionId) return NextResponse.json({ error: "Not open for this helper" }, { status: 404 });
  const resume = await Resume.findById(application.resumeVersionId).select("fileUrl");
  if (!resume?.fileUrl) return NextResponse.json({ error: "No resume file" }, { status: 404 });

  const file = await materializeStoredFile(resume.fileUrl);
  try {
    const bytes = await readFile(file.path);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
  } finally {
    await file.cleanup();
  }
}, "assist:use");
