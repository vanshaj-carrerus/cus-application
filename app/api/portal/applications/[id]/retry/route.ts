import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Job } from "@/lib/models/Job";

/** A candidate asked to try an unfinished (draft) application again: it goes to the front of the next Start run, which the page then starts. */
export const POST = withAuth(async (_req: NextRequest, { params, user }) => {
  if (user.role !== "CANDIDATE" || !user.candidateId) return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  await connectDB();

  const application = await Application.findOne({ _id: params.id, candidateId: user.candidateId }).select("status automationStatus jobId");
  if (!application || application.status === "APPLIED") return NextResponse.json({ error: "Application not found" }, { status: 404 });
  const job = await Job.findById(application.jobId).select("source");
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Attempts start again from zero and the update time moves it to the front of the retry list.
  await Application.updateOne({ _id: application._id }, { $set: { automationStatus: "FAILED", "confirmationData.attempts": 0 } });
  return NextResponse.json({ portal: job.source });
});
