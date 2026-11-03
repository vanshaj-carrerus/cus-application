import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";

const bodySchema = z.object({
  /** APPLIED: the marketer submitted it (the assistant didn't see a confirmation page). RESET: put it back in the queue. */
  outcome: z.enum(["APPLIED", "RESET"]),
  note: z.string().max(500).optional(),
});

export const POST = withAuth(async (req: NextRequest, { params, user }) => {
  await connectDB();
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "outcome must be APPLIED or RESET" }, { status: 400 });
  const { outcome, note } = parsed.data;

  const application = await Application.findById(params.id);
  if (!application || !canWorkOnCandidate(user, application.candidateId)) return NextResponse.json({ error: "Application not found" }, { status: 404 });

  if (outcome === "APPLIED") {
    if (application.status === "APPLIED" && application.automationStatus === "SUBMITTED") return NextResponse.json({ application });
    application.status = "APPLIED";
    application.automationStatus = "SUBMITTED";
    application.appliedAt = new Date();
    application.appliedBy = user.sub as never;
    application.timeline.push({ status: "APPLIED", note: note || "Marked as applied by hand", changedBy: user.sub as never, changedAt: new Date() });
    await application.save();
    await AutoApplyProfile.updateOne({ candidateId: application.candidateId }, { $inc: { appliedToday: 1 } });
  } else {
    if (application.status === "APPLIED") return NextResponse.json({ error: "Already applied" }, { status: 409 });
    application.automationStatus = "READY_TO_APPLY";
    application.assist = undefined;
    application.timeline.push({ status: application.status, note: note || "Put back in the apply queue", changedBy: user.sub as never, changedAt: new Date() });
    await application.save();
  }
  return NextResponse.json({ application });
}, "assist:use");
