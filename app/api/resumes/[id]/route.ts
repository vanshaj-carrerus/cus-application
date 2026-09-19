import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Resume } from "@/lib/models/Resume";
import { Application } from "@/lib/models/Application";
import { deleteStoredFile } from "@/lib/storage/fileStorage";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const resume = await Resume.findById(params.id);
  if (!resume) return NextResponse.json({ error: "Resume not found" }, { status: 404 });
  return NextResponse.json({ resume });
}, "resumes:read");

/**
 * A resume version still referenced by an application is left alone — deleting it
 * would strand that application's "Auto-Apply Artifacts" / cover-letter view with a
 * dangling reference. Delete the application first (or its resume gets swapped) if
 * it's genuinely no longer needed.
 */
export const DELETE = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const resume = await Resume.findById(params.id);
  if (!resume) return NextResponse.json({ error: "Resume not found" }, { status: 404 });

  const inUse = await Application.exists({ resumeVersionId: resume._id });
  if (inUse) {
    return NextResponse.json({ error: "This resume version is attached to an application — delete or reassign that application first." }, { status: 409 });
  }

  if (resume.fileUrl) await deleteStoredFile(resume.fileUrl);
  await resume.deleteOne();

  return NextResponse.json({ deleted: true });
}, "resumes:write");
