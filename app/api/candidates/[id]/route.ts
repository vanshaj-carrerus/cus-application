import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { Resume } from "@/lib/models/Resume";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { JobBoardCredential } from "@/lib/models/JobBoardCredential";
import { User } from "@/lib/models/User";
import { deleteStoredFile } from "@/lib/storage/fileStorage";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const candidate = await Candidate.findById(params.id);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  return NextResponse.json({ candidate });
}, "candidates:read");

export const PATCH = withAuth(async (req: NextRequest, { params }) => {
  await connectDB();
  const body = await req.json();
  const candidate = await Candidate.findByIdAndUpdate(params.id, { $set: body }, { new: true });
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  return NextResponse.json({ candidate });
}, "candidates:write");

/**
 * Deleting a candidate cascades through everything that only makes sense tied to
 * them: applications (and their automation attempts), resume versions and their
 * stored files, the auto-apply profile, saved job-board credentials, and the
 * portal login account. Nothing here is meaningful once the candidate is gone.
 */
export const DELETE = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const candidate = await Candidate.findById(params.id);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  await ApplicationAttempt.deleteMany({ candidateId: candidate._id });
  await Application.deleteMany({ candidateId: candidate._id });

  const resumes = await Resume.find({ candidateId: candidate._id }).select("fileUrl");
  await Promise.all(resumes.map((r) => (r.fileUrl ? deleteStoredFile(r.fileUrl) : Promise.resolve())));
  await Resume.deleteMany({ candidateId: candidate._id });

  await AutoApplyProfile.deleteMany({ candidateId: candidate._id });
  await JobBoardCredential.deleteMany({ candidateId: candidate._id });
  await User.deleteMany({ candidateId: candidate._id, role: "CANDIDATE" });

  await candidate.deleteOne();

  return NextResponse.json({ deleted: true });
}, "candidates:write");
