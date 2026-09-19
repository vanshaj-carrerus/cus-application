import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const job = await Job.findById(params.id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}, "jobs:read");

/**
 * Deleting a job also removes every application against it — an application
 * pointing at a job that no longer exists is dead weight, not something worth
 * keeping around, so this cascades rather than leaving orphans.
 */
export const DELETE = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const job = await Job.findById(params.id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const applications = await Application.find({ jobId: job._id }).select("_id");
  const applicationIds = applications.map((a) => a._id);

  await ApplicationAttempt.deleteMany({ jobId: job._id });
  await Application.deleteMany({ _id: { $in: applicationIds } });
  await job.deleteOne();

  return NextResponse.json({ deleted: true, applicationsDeleted: applicationIds.length });
}, "jobs:write");
