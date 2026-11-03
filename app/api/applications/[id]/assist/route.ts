import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Job } from "@/lib/models/Job";
import { Resume } from "@/lib/models/Resume";
import type { AutomationStatus } from "@/lib/models/enums";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";

// States a marketer can start (or restart) an application from. Anything else is already being worked on or done.
const STARTABLE = ["READY_TO_APPLY", "AWAITING_REVIEW", "FAILED"];

/** The marketer clicked Apply: mark it as waiting for their desktop helper, which the portal then opens through a cusassist:// link. */
export const POST = withAuth(async (_req: NextRequest, { params, user }) => {
  await connectDB();
  const application = await Application.findById(params.id);
  if (!application || !canWorkOnCandidate(user, application.candidateId)) return NextResponse.json({ error: "Application not found" }, { status: 404 });
  if (!STARTABLE.includes(application.automationStatus)) {
    return NextResponse.json({ error: `This application is ${application.automationStatus.replace(/_/g, " ").toLowerCase()} and can't be started` }, { status: 409 });
  }

  const [job, resume] = await Promise.all([Job.findById(application.jobId).select("applicationUrl"), application.resumeVersionId ? Resume.findById(application.resumeVersionId).select("fileUrl") : null]);
  if (!job?.applicationUrl) return NextResponse.json({ error: "This job has no apply link" }, { status: 422 });
  if (!resume?.fileUrl) return NextResponse.json({ error: "The tailored resume isn't ready yet" }, { status: 422 });

  // Atomic, so two clicks (or two marketers) can't both claim the same application.
  const updated = await Application.findOneAndUpdate(
    { _id: application._id, automationStatus: { $in: STARTABLE as AutomationStatus[] } },
    {
      $set: { automationStatus: "APPLY_REQUESTED", assist: { requestedBy: user.sub, requestedAt: new Date() } },
      $unset: { failureReason: 1 },
      $push: { timeline: { status: application.status, note: "Apply clicked, waiting for the assistant browser", changedBy: user.sub, changedAt: new Date() } },
    },
    { new: true }
  );
  if (!updated) return NextResponse.json({ error: "Someone else just started this application" }, { status: 409 });
  return NextResponse.json({ application: updated });
}, "assist:use");

/** Cancel a request the assistant hasn't picked up yet. */
export const DELETE = withAuth(async (_req: NextRequest, { params, user }) => {
  await connectDB();
  const owned = await Application.findById(params.id).select("candidateId");
  if (!owned || !canWorkOnCandidate(user, owned.candidateId)) return NextResponse.json({ error: "Nothing to cancel" }, { status: 409 });
  const updated = await Application.findOneAndUpdate(
    { _id: params.id, automationStatus: "APPLY_REQUESTED" },
    { $set: { automationStatus: "READY_TO_APPLY" }, $unset: { assist: 1 } },
    { new: true }
  );
  if (!updated) return NextResponse.json({ error: "Nothing to cancel" }, { status: 409 });
  return NextResponse.json({ application: updated });
}, "assist:use");
