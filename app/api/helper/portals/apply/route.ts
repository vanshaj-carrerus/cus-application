import { NextResponse } from "next/server";
import { withHelperAuth } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { resolveHelperCandidate } from "@/lib/portals/helperCandidate";
import { localAnswerBackend } from "@/lib/automation/localAnswerBackend";
import type { FormQuestion, JobInfo } from "@/lib/automation/formEngine";
import { PortalSyncError } from "@/lib/services/portalSyncService";
import { claimJob, finishApply, loadCandidateResume, planApply, recordResult, setApplyState, type JobResult } from "@/lib/services/portalApplyService";

export const runtime = "nodejs";
export const maxDuration = 90;

type Body = { candidateId?: string; portal?: string } & (
  | { action: "plan" }
  | { action: "resume" }
  | { action: "claim"; job: JobResult }
  | { action: "progress"; state: "RUNNING" | "PAUSED"; message: string }
  | { action: "answers"; job?: JobInfo; request: { action: "lookup"; asked: Array<{ id: string; label: string }> } | { action: "ask"; questions: FormQuestion[]; job?: JobInfo } | { action: "used"; savedIds: string[] } | { action: "needed"; questions: Array<{ label: string; options?: string[]; required?: boolean }>; askedOn?: string } }
  | { action: "result"; job: JobResult; outcome: "APPLIED" | "SKIPPED" | "FAILED" | "NEEDS_HUMAN"; reason?: string; pageUrl?: string }
  | { action: "finish"; state: "DONE" | "STOPPED" | "FAILED"; message: string }
);

/** The server half of a Start run: the plan, answers to the form's questions, and the record of each job. */
export const POST = withHelperAuth(async (req, { user }) => {
  await connectDB();
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.action || !body.portal) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const candidateId = await resolveHelperCandidate(user, body.candidateId);
  if (!candidateId) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });

  try {
    switch (body.action) {
      case "plan":
        return NextResponse.json(await planApply(candidateId, body.portal));

      case "resume":
        return NextResponse.json({ resume: await loadCandidateResume(candidateId) });

      case "claim":
        return NextResponse.json({ ok: await claimJob(candidateId, body.portal, body.job.id) });

      case "progress":
        await setApplyState(candidateId, body.portal, body.state, body.message ?? "");
        return NextResponse.json({ ok: true });

      case "result":
        return NextResponse.json(await recordResult(candidateId, user.sub, body.portal, body.job, body.outcome, body.reason, body.pageUrl));

      case "finish":
        await finishApply(candidateId, body.portal, body.state, body.message ?? "");
        return NextResponse.json({ ok: true });

      case "answers": {
        const candidate = await Candidate.findById(candidateId);
        if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
        const backend = localAnswerBackend(candidate);
        const r = body.request;
        switch (r?.action) {
          case "lookup":
            return NextResponse.json({ answers: Array.from(await backend.lookupSaved(r.asked ?? []), ([id, v]) => ({ id, ...v })) });
          case "ask":
            return NextResponse.json({ answers: await backend.askModel(r.questions ?? [], body.job ?? r.job ?? { title: "", company: "" }) });
          case "used":
            await backend.markUsed(r.savedIds ?? []);
            return NextResponse.json({ ok: true });
          case "needed":
            return NextResponse.json({ created: await backend.recordNeeded(r.questions ?? [], r.askedOn) });
        }
        return NextResponse.json({ error: "Unknown request" }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    if (err instanceof PortalSyncError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}, "assist:use");
