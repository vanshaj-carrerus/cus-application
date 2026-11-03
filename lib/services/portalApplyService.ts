import { readFile } from "node:fs/promises";
import { Application } from "@/lib/models/Application";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { Resume } from "@/lib/models/Resume";
import { materializeStoredFile } from "@/lib/storage/fileStorage";
import { PortalJobClaim } from "@/lib/models/PortalJobClaim";
import { PortalSnapshot, type PortalApplyRun } from "@/lib/models/PortalSnapshot";
import { getPortal } from "@/lib/portals/catalog";
import { PortalConnection } from "@/lib/models/PortalConnection";
import { PortalSyncError } from "@/lib/services/portalSyncService";

const MAX_SEARCHES = 6;
const LOG_LIMIT = 100;
/** One Start run works until this many applications are sent (or there is nothing left to apply to). */
export const RUN_TARGET = 10;
/** A job that failed is tried again on later Starts, up to this many attempts in all. */
const MAX_ATTEMPTS = 4;

export interface ApplyJobCard {
  id: string;
  title: string;
  company?: string;
  location?: string;
  url?: string;
}

export interface ApplyPlan {
  searches: Array<{ keywords: string; location: string }>;
  /** Applications this run sends before it finishes. */
  runTarget: number;
  /** Applications left under today's cap. */
  remaining: number;
  excludeKeywords: string[];
  candidate: { name: string; email?: string; phone?: string; location?: string; linkedinUrl?: string; portfolioUrl?: string; githubUrl?: string };
  /** Portal job ids this candidate already has an application for, so a re-run never applies twice. */
  appliedIds: string[];
  /** Applications that were started but not finished (a question needed the candidate, a step stalled). Done first. */
  retryJobs: ApplyJobCard[];
}

/** A low daily limit left over from testing must not cut a run short of its target. */
const dailyCap = (limit: number) => Math.max(limit, RUN_TARGET);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Everything a Start run needs, or a PortalSyncError saying what to set up first. Also opens the run record. */
export async function planApply(candidateId: string, portal: string): Promise<ApplyPlan> {
  if (!getPortal(portal)?.autoApply) throw new PortalSyncError("Auto-apply isn't available for this portal yet");
  if (!(await PortalConnection.exists({ candidateId, portal }))) throw new PortalSyncError(`Connect ${getPortal(portal)?.name ?? "this portal"} first.`, 409);

  const [candidate, profile] = await Promise.all([Candidate.findById(candidateId), AutoApplyProfile.findOne({ candidateId })]);
  if (!candidate) throw new PortalSyncError("Candidate not found", 404);
  if (!profile || profile.keywords.length === 0) throw new PortalSyncError("Add search keywords in the candidate's Auto-apply settings first.", 409);

  if (profile.appliedTodayResetAt < startOfToday()) {
    profile.appliedToday = 0;
    profile.appliedTodayResetAt = new Date();
    await profile.save();
  }
  const leftToday = dailyCap(profile.dailyApplyLimit) - profile.appliedToday;
  if (leftToday <= 0) throw new PortalSyncError(`The daily limit of ${dailyCap(profile.dailyApplyLimit)} applications has been reached. It resets tomorrow.`, 409);
  const remaining = leftToday;

  const locations = profile.locations.length ? profile.locations : [""];
  const searches = profile.keywords.flatMap((keywords) => locations.map((location) => ({ keywords, location }))).slice(0, MAX_SEARCHES);

  // Unfinished applications come first; everything else the candidate already has (sent or queued) is never searched for again.
  const [apps, unfinished] = await Promise.all([
    Application.find({ candidateId, automationStatus: { $ne: "FAILED" } }).select("jobId").lean(),
    Application.find({ candidateId, automationStatus: "FAILED", status: { $ne: "APPLIED" }, "confirmationData.attempts": { $lt: MAX_ATTEMPTS } }).sort({ updatedAt: -1 }).limit(15).select("jobId").lean(),
  ]);
  const [jobs, retry] = await Promise.all([
    Job.find({ _id: { $in: apps.map((a) => a.jobId) }, source: portal }).select("externalJobId").lean(),
    Job.find({ _id: { $in: unfinished.map((a) => a.jobId) }, source: portal }).lean(),
  ]);
  const retryJobs: ApplyJobCard[] = unfinished
    .map((a) => retry.find((j) => String(j._id) === String(a.jobId)))
    .filter((j): j is NonNullable<typeof j> => !!j)
    .map((j) => ({ id: j.externalJobId, title: j.title, company: j.company === "Unknown company" ? undefined : j.company, location: j.location, url: j.applicationUrl }));

  // Another Start while runs are going adds a run to the same record; otherwise a fresh record begins.
  const current = (await PortalSnapshot.findOne({ candidateId, portal }).select("apply"))?.apply as PortalApplyRun | undefined;
  const ongoing = !!current && (current.state === "RUNNING" || current.state === "PAUSED") && (current.activeRuns ?? 0) > 0 && Date.now() - new Date(current.startedAt).getTime() < 3 * 60 * 60_000;
  if (ongoing) {
    await PortalSnapshot.updateOne({ candidateId, portal }, { $inc: { "apply.activeRuns": 1 }, $set: { "apply.message": "Another run started" } });
  } else {
    const run: PortalApplyRun = { state: "RUNNING", message: "Starting…", startedAt: new Date(), activeRuns: 1, applied: 0, skipped: 0, failed: 0, log: [] };
    await PortalSnapshot.updateOne({ candidateId, portal }, { $set: { apply: run } }, { upsert: true });
  }

  return {
    searches,
    runTarget: RUN_TARGET,
    remaining,
    excludeKeywords: profile.excludeKeywords,
    candidate: {
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.location,
      linkedinUrl: candidate.linkedinUrl,
      portfolioUrl: candidate.portfolioUrl,
      githubUrl: candidate.githubUrl,
    },
    appliedIds: jobs.map((j) => j.externalJobId),
    retryJobs,
  };
}

/** Progress from a run. It never turns a Stop request back into "running". */
export async function setApplyState(candidateId: string, portal: string, state: PortalApplyRun["state"], message: string) {
  await PortalSnapshot.updateOne({ candidateId, portal, "apply.state": { $exists: true } }, { $set: { "apply.message": message.slice(0, 300) } });
  if (state === "RUNNING" || state === "PAUSED") {
    await PortalSnapshot.updateOne({ candidateId, portal, "apply.state": { $in: ["RUNNING", "PAUSED"] } }, { $set: { "apply.state": state } });
  }
}

/** One run ended. The record only becomes finished when the last run has. */
export async function finishApply(candidateId: string, portal: string, state: "DONE" | "STOPPED" | "FAILED", message: string) {
  const snap = await PortalSnapshot.findOneAndUpdate({ candidateId, portal, "apply.activeRuns": { $gt: 0 } }, { $inc: { "apply.activeRuns": -1 } }, { new: true }).select("apply");
  const left = Number(snap?.apply?.activeRuns ?? 0);
  if (left > 0) {
    await PortalSnapshot.updateOne({ candidateId, portal }, { $set: { "apply.message": `A run finished (${message.slice(0, 120)}). ${left} still working.` } });
    return;
  }
  await PortalSnapshot.updateOne(
    { candidateId, portal, "apply.state": { $exists: true } },
    { $set: { "apply.state": state, "apply.message": message.slice(0, 300), "apply.finishedAt": new Date() } }
  );
}

/** A run asks for a job before opening it. False means another run already has it. */
export async function claimJob(candidateId: string, portal: string, externalJobId: string): Promise<boolean> {
  try {
    await PortalJobClaim.create({ candidateId, portal, externalJobId });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/** The person pressed Stop: the extension sees this on its next result and ends the run cleanly. */
export async function requestStop(candidateId: string, portal: string) {
  await PortalSnapshot.updateOne(
    { candidateId, portal, "apply.state": { $in: ["RUNNING", "PAUSED"] } },
    { $set: { "apply.state": "STOPPING", "apply.message": "Stopping after the current job…" } }
  );
}

export interface JobResult {
  id: string;
  title: string;
  company?: string;
  location?: string;
  url?: string;
}

/** Records what happened to one job. Returns whether the run should stop and how many applications are left today. */
export async function recordResult(candidateId: string, userId: string, portal: string, job: JobResult, outcome: string, reason?: string) {
  const title = (job.title || "Untitled job").slice(0, 300);
  const company = job.company?.slice(0, 200);

  const candidate = outcome === "APPLIED" || outcome === "FAILED" ? await Candidate.findById(candidateId).select("assignedRecruiterId") : null;
  const now = new Date();
  const portalName = getPortal(portal)?.name ?? portal;

  if (outcome === "APPLIED" || outcome === "FAILED") {
    const url = job.url?.slice(0, 500);
    const jobDoc = await Job.findOneAndUpdate(
      { source: portal, externalJobId: job.id },
      { $setOnInsert: { title, company: company || "Unknown company", description: `Applied through ${portalName}. The posting text was not stored.`, location: job.location?.slice(0, 200), applicationUrl: url, sourceUrl: url, status: "ACTIVE" } },
      { upsert: true, new: true }
    );
    // A company name learned later replaces the placeholder.
    if (company && jobDoc.company === "Unknown company") await Job.updateOne({ _id: jobDoc._id }, { $set: { company } });
    const existing = await Application.findOne({ candidateId, jobId: jobDoc._id }).select("status");

    if (outcome === "APPLIED") {
      await Application.updateOne(
        { candidateId, jobId: jobDoc._id },
        {
          $set: { status: "APPLIED", appliedAt: now, appliedBy: userId, automationStatus: "SUBMITTED" },
          $unset: { failureReason: "" },
          $setOnInsert: { recruiterId: candidate?.assignedRecruiterId ?? userId },
          $push: { timeline: { status: "APPLIED", note: `Applied automatically on ${portalName}`, changedAt: now } },
        },
        { upsert: true }
      );
      await AutoApplyProfile.updateOne({ candidateId }, { $inc: { appliedToday: 1 }, $set: { lastRunAt: now } });
    } else if (existing?.status !== "APPLIED") {
      // Not finished: kept (with the reason) so the next Start picks it up first.
      await Application.updateOne(
        { candidateId, jobId: jobDoc._id },
        {
          $set: { automationStatus: "FAILED", failureReason: (reason ?? "Not finished").slice(0, 500) },
          $inc: { "confirmationData.attempts": 1 },
          $setOnInsert: { recruiterId: candidate?.assignedRecruiterId ?? userId, status: "DRAFT" },
        },
        { upsert: true }
      );
    }
  }

  if (outcome !== "APPLIED") await PortalJobClaim.deleteOne({ candidateId, portal, externalJobId: job.id });

  const counter = outcome === "APPLIED" ? "apply.applied" : outcome === "SKIPPED" ? "apply.skipped" : "apply.failed";
  await PortalSnapshot.updateOne(
    { candidateId, portal },
    {
      $inc: { [counter]: 1 },
      $push: { "apply.log": { $each: [{ at: new Date(), title, company, outcome, reason: reason?.slice(0, 300) }], $slice: -LOG_LIMIT } },
    }
  );

  const snap = await PortalSnapshot.findOne({ candidateId, portal }).select("apply.state apply.applied");
  const profile = await AutoApplyProfile.findOne({ candidateId }).select("dailyApplyLimit appliedToday");
  const leftToday = profile ? dailyCap(profile.dailyApplyLimit) - profile.appliedToday : 0;
  // Each run counts its own applications against the run target; the server only knows today's cap, shared by every run.
  return { stop: snap?.apply?.state === "STOPPING", remaining: leftToday };
}

/** The candidate's own resume file (the one chosen in their Auto-apply settings, else the newest uploaded one), for the extension to attach. */
export async function loadCandidateResume(candidateId: string): Promise<{ name: string; mime: string; base64: string } | null> {
  const profile = await AutoApplyProfile.findOne({ candidateId }).select("baseResumeId");
  const chosen = profile?.baseResumeId ? await Resume.findById(profile.baseResumeId).select("fileUrl") : null;
  const newest = chosen?.fileUrl ? chosen : await Resume.findOne({ candidateId, fileUrl: { $exists: true, $ne: "" } }).sort({ isTailored: 1, createdAt: -1 }).select("fileUrl");
  const candidate = await Candidate.findById(candidateId).select("name resumeFiles");
  const url = newest?.fileUrl ?? candidate?.resumeFiles?.at(-1)?.url;
  if (!url || !candidate) return null;

  const file = await materializeStoredFile(url);
  try {
    const bytes = await readFile(file.path);
    const ext = (url.split("?")[0].match(/\.(pdf|docx?)$/i)?.[1] ?? "pdf").toLowerCase();
    const mime = ext === "pdf" ? "application/pdf" : ext === "doc" ? "application/msword" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return { name: `${candidate.name.replace(/[^a-z0-9]+/gi, "_")}_Resume.${ext}`, mime, base64: bytes.toString("base64") };
  } finally {
    await file.cleanup();
  }
}
