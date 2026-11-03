import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { tailorApplicationForJob } from "@/lib/services/resumeTailorService";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";

export const runtime = "nodejs";
export const maxDuration = 120;

/** (Re)generate the tailored resume and cover letter for one application, e.g. after a failed preparation. */
export const POST = withAuth(async (_req: NextRequest, { params, user }) => {
  await connectDB();
  const application = await Application.findById(params.id).select("automationStatus status candidateId");
  if (!application || !canWorkOnCandidate(user, application.candidateId)) return NextResponse.json({ error: "Application not found" }, { status: 404 });
  if (application.automationStatus === "IN_PROGRESS" || application.automationStatus === "APPLY_REQUESTED" || application.status === "APPLIED") {
    return NextResponse.json({ error: "This application is already being worked on or submitted" }, { status: 409 });
  }
  try {
    await tailorApplicationForJob(params.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Application.updateOne({ _id: params.id }, { $set: { failureReason: `Could not prepare: ${message}` } });
    return NextResponse.json({ error: `Could not prepare: ${message}` }, { status: 502 });
  }
  return NextResponse.json({ prepared: true });
}, "assist:use");
