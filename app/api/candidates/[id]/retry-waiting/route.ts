import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { playwrightApplyQueue } from "@/lib/queue/queues";

/**
 * After someone has answered the questions the bot was missing, re-run the applications that were stopped for
 * exactly that reason (and no others - a CAPTCHA or login problem would not be fixed by an answer).
 */
export const POST = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const waiting = await Application.find({ candidateId: params.id, automationStatus: "AWAITING_REVIEW" }).select("_id jobId");

  const queued: string[] = [];
  for (const app of waiting) {
    const last = await ApplicationAttempt.findOne({ applicationId: app._id }).sort({ attemptNumber: -1 }).select("steps");
    const stoppedOnQuestions = last?.steps.some((s) => s.step === "form_questions" && s.status === "FAILED");
    if (!stoppedOnQuestions) continue;

    await Application.updateOne(
      { _id: app._id },
      { $set: { automationStatus: "QUEUED" }, $push: { timeline: { status: "TAILORED", note: "Re-queued after the missing answers were saved", changedAt: new Date() } } }
    );
    await playwrightApplyQueue().add("apply", { applicationId: String(app._id), candidateId: params.id, jobId: String(app.jobId) });
    queued.push(String(app._id));
  }
  return NextResponse.json({ queued: queued.length, applicationIds: queued });
}, "applications:write");
