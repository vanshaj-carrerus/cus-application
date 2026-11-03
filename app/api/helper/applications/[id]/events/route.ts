import { NextResponse } from "next/server";
import { withHelperAuth } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { saveFile } from "@/lib/storage/fileStorage";

export const runtime = "nodejs";
export const maxDuration = 60;

type Event =
  | { type: "step"; attemptId: string; step: string; status: "STARTED" | "SUCCESS" | "FAILED" | "SKIPPED"; message?: string }
  | { type: "submitted"; attemptId: string; evidence: string; finalUrl?: string; screenshotBase64?: string }
  | { type: "closed"; attemptId: string; note?: string }
  | { type: "error"; attemptId: string; error: string };

/** What happened in the marketer's browser: progress steps, the submission, or the window being closed / failing. */
export const POST = withHelperAuth(async (req, { params, user }) => {
  await connectDB();
  const event = (await req.json().catch(() => null)) as Event | null;
  if (!event?.type) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const application = await Application.findOne({ _id: params.id, "assist.requestedBy": user.sub });
  if (!application) return NextResponse.json({ error: "Not your application" }, { status: 404 });
  const attempt = await ApplicationAttempt.findOne({ _id: event.attemptId, applicationId: application._id });
  if (!attempt) return NextResponse.json({ error: "Unknown attempt" }, { status: 404 });
  const pushStep = (step: string, status: "STARTED" | "SUCCESS" | "FAILED" | "SKIPPED", message?: string) =>
    ApplicationAttempt.updateOne({ _id: attempt._id }, { $push: { steps: { step, status, message: message?.slice(0, 1000), timestamp: new Date() } } });

  switch (event.type) {
    case "step":
      await pushStep(event.step, event.status, event.message);
      return NextResponse.json({ ok: true });

    case "submitted": {
      if (application.status === "APPLIED") return NextResponse.json({ ok: true });
      let proofUrl: string | undefined;
      if (event.screenshotBase64) {
        try {
          proofUrl = (await saveFile(Buffer.from(event.screenshotBase64, "base64"), { subdir: `proofs/${application.candidateId}`, extension: "png" })).url;
        } catch {
          /* a missing proof image must not lose the submission */
        }
      }
      await ApplicationAttempt.updateOne(
        { _id: attempt._id },
        { $set: { status: "SUCCESS", finishedAt: new Date(), submissionConfirmation: { finalUrl: event.finalUrl, evidence: event.evidence } } }
      );
      await pushStep("confirmed", "SUCCESS", event.evidence);
      await Application.updateOne(
        { _id: application._id },
        {
          $set: { status: "APPLIED", automationStatus: "SUBMITTED", appliedAt: new Date(), appliedBy: user.sub, ...(proofUrl ? { applicationProofScreenshot: proofUrl } : {}) },
          $push: { timeline: { status: "APPLIED", note: `Applied by ${user.name} in the assistant browser (${event.evidence})`, changedBy: user.sub, changedAt: new Date() } },
        }
      );
      await AutoApplyProfile.updateOne({ candidateId: application.candidateId }, { $inc: { appliedToday: 1 } });
      return NextResponse.json({ ok: true });
    }

    case "closed":
    case "error": {
      const failed = event.type === "error";
      await ApplicationAttempt.updateOne({ _id: attempt._id }, { $set: { status: failed ? "FAILED" : "NEEDS_REVIEW", finishedAt: new Date(), ...(failed ? { errorMessage: event.error } : {}) } });
      await pushStep(failed ? "error" : "closed", failed ? "FAILED" : "SKIPPED", failed ? event.error : (event.note ?? "The browser was closed before an application confirmation was seen"));
      // Only put it back in the queue if it is still open; a submission recorded earlier stays recorded.
      await Application.updateOne(
        { _id: application._id, automationStatus: "IN_PROGRESS" },
        {
          $set: { automationStatus: "READY_TO_APPLY", ...(failed ? { failureReason: event.error } : {}) },
          $unset: { assist: 1 },
          $push: { timeline: { status: application.status, note: failed ? `Assistant browser failed: ${event.error}` : "Assistant browser closed without a confirmation, back in the apply queue", changedAt: new Date() } },
        }
      );
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: "Unknown event" }, { status: 400 });
  }
}, "assist:use");
