import { NextResponse } from "next/server";
import { withHelperAuth } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { classifyHost } from "@/lib/automation/hostPolicy";
import { buildAssistPayload } from "@/lib/automation/assistPayload";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The helper opened the application's link: take it (APPLY_REQUESTED -> IN_PROGRESS, only for the marketer who
 * clicked Apply) and return everything the helper needs to run the browser session.
 */
export const POST = withHelperAuth(async (_req, { params, user }) => {
  await connectDB();
  const claimed = await Application.findOneAndUpdate(
    { _id: params.id, automationStatus: "APPLY_REQUESTED", "assist.requestedBy": user.sub },
    { $set: { automationStatus: "IN_PROGRESS", "assist.claimedAt": new Date() } },
    { new: true }
  );
  if (!claimed) {
    const existing = await Application.findById(params.id).select("automationStatus assist");
    const why = !existing
      ? "That application no longer exists."
      : existing.assist?.requestedBy && String(existing.assist.requestedBy) !== user.sub
        ? "Another team member started this application."
        : existing.automationStatus === "IN_PROGRESS"
          ? "This application is already open in a browser."
          : "Click Apply on this application in the portal first.";
    return NextResponse.json({ error: why }, { status: 409 });
  }

  try {
    const payload = await buildAssistPayload(claimed);
    const attempt = await ApplicationAttempt.create({
      applicationId: claimed._id,
      candidateId: claimed.candidateId,
      jobId: claimed.jobId,
      board: classifyHost(payload.entryUrl).sessionBoard ?? "OTHER",
      attemptNumber: (await ApplicationAttempt.countDocuments({ applicationId: claimed._id })) + 1,
      status: "RUNNING",
      startedAt: new Date(),
    });
    return NextResponse.json({ ...payload, attemptId: String(attempt._id), operatorName: user.name });
  } catch (err) {
    await Application.updateOne({ _id: claimed._id }, { $set: { automationStatus: "READY_TO_APPLY" }, $unset: { assist: 1 } });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not start this application" }, { status: 422 });
  }
}, "assist:use");
