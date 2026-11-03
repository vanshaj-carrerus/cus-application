import { NextResponse } from "next/server";
import { withHelperAuth } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import type { FormQuestion, JobInfo } from "@/lib/automation/formEngine";
import { localAnswerBackend } from "@/lib/automation/localAnswerBackend";

export const runtime = "nodejs";
export const maxDuration = 90;

type Body =
  | { action: "lookup"; asked: Array<{ id: string; label: string }> }
  | { action: "ask"; questions: FormQuestion[]; job?: JobInfo; coverLetter?: string }
  | { action: "used"; savedIds: string[] }
  | { action: "needed"; questions: Array<{ label: string; options?: string[] }>; askedOn?: string };

/**
 * The server-side half of form answering for the helper: saved answers, the AI model, and recording questions a
 * person still has to answer. The AI keys and the database never leave the server.
 */
export const POST = withHelperAuth(async (req, { params, user }) => {
  await connectDB();
  const application = await Application.findOne({ _id: params.id, automationStatus: "IN_PROGRESS", "assist.requestedBy": user.sub });
  if (!application) return NextResponse.json({ error: "Not open for this helper" }, { status: 404 });
  const [candidate, job] = await Promise.all([Candidate.findById(application.candidateId), Job.findById(application.jobId)]);
  if (!candidate || !job) return NextResponse.json({ error: "Candidate or job missing" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const backend = localAnswerBackend(candidate);

  switch (body.action) {
    case "lookup": {
      const found = await backend.lookupSaved(body.asked ?? []);
      return NextResponse.json({ answers: Array.from(found, ([id, v]) => ({ id, ...v })) });
    }
    case "ask": {
      const answers = await backend.askModel(body.questions ?? [], { title: job.title, company: job.company, description: job.description?.slice(0, 1500) }, application.coverLetter);
      return NextResponse.json({ answers });
    }
    case "used":
      await backend.markUsed(body.savedIds ?? []);
      return NextResponse.json({ ok: true });
    case "needed":
      return NextResponse.json({ created: await backend.recordNeeded(body.questions ?? [], body.askedOn) });
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}, "assist:use");
