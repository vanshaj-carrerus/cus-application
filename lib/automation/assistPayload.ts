import type { ICandidate } from "@/lib/models/Candidate";
import type { IApplication } from "@/lib/models/Application";
import type { IJob } from "@/lib/models/Job";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { SavedAnswer } from "@/lib/models/SavedAnswer";
import { JobApiAdapter, findDirectApplyLink } from "@/lib/adapters/jobApiAdapter";
import { classifyHost, hostOf } from "@/lib/automation/hostPolicy";
import { directApplicationUrl } from "@/lib/automation/adapters";
import { Application } from "@/lib/models/Application";

/** What the desktop helper needs to run one application: plain data only, never database objects. */
export interface AssistPayload {
  applicationId: string;
  candidateId: string;
  entryUrl: string;
  candidate: Record<string, unknown>;
  job: { title: string; company: string; description?: string };
  coverLetter?: string;
  quickCopy: Array<{ label: string; value: string }>;
  resumeFileName: string;
}

/** The candidate as plain JSON, without the bulky parts the helper never needs. */
export function plainCandidate(candidate: ICandidate): Record<string, unknown> {
  const { resumeText: _resumeText, resumeFiles: _resumeFiles, ...rest } = candidate.toObject() as unknown as Record<string, unknown>;
  void _resumeText;
  void _resumeFiles;
  return { ...rest, _id: String(candidate._id) };
}

/** Everything a marketer might need to paste into a custom question, from the candidate's profile and saved answers. */
export function quickCopyItems(candidate: ICandidate, coverLetter: string | undefined, saved: Array<{ question: string; answer: string }>): Array<{ label: string; value: string }> {
  const a = candidate.address;
  const money = candidate.expectedSalary ? `${candidate.expectedSalary}${candidate.currency ? ` ${candidate.currency}` : ""}` : "";
  const candidates: Array<[string, string | undefined]> = [
    ["Full name", candidate.name],
    ["Email", candidate.email],
    ["Phone", candidate.phone],
    ["Location", candidate.location ?? [a?.city, a?.state, a?.country].filter(Boolean).join(", ")],
    ["LinkedIn", candidate.linkedinUrl],
    ["Portfolio", candidate.portfolioUrl],
    ["GitHub", candidate.githubUrl],
    ["Expected salary", money],
    ["Notice period", candidate.noticePeriod],
    ["Years of experience", candidate.yearsOfExperience != null ? String(candidate.yearsOfExperience) : undefined],
    ["Work authorization", candidate.workAuthorization],
    ["Cover letter", coverLetter],
  ];
  const items = candidates.filter((c): c is [string, string] => !!c[1]).map(([label, value]) => ({ label, value }));
  for (const s of saved) if (s.answer) items.push({ label: s.question.slice(0, 80), value: s.answer });
  return items;
}

export async function buildAssistPayload(application: IApplication): Promise<AssistPayload> {
  const [candidate, job] = await Promise.all([Candidate.findById(application.candidateId), Job.findById(application.jobId)]);
  if (!candidate) throw new Error("Candidate not found");
  if (!job?.applicationUrl) throw new Error("This job has no apply link");

  // A LinkedIn / Indeed link is often just one of the places a listing appears; the employer's own apply link
  // (when the job API knows it) needs no board account, so open that instead.
  const original = classifyHost(job.applicationUrl);
  if (original.hostClass === "SESSION" && job.source === JobApiAdapter.SOURCE_NAME) {
    const direct = await findDirectApplyLink(job.externalJobId).catch(() => undefined);
    if (direct && classifyHost(direct).hostClass !== "SESSION") {
      await Application.updateOne(
        { _id: application._id },
        { $push: { timeline: { status: application.status, note: `Opened the employer's own link (${hostOf(direct)}) instead of ${original.host}`, changedAt: new Date() } } }
      );
      job.applicationUrl = direct;
      await (job as IJob).save();
    }
  }

  const saved = await SavedAnswer.find({ candidateId: candidate._id, status: "ANSWERED" }).select("question answer").limit(60).lean<Array<{ question: string; answer: string }>>();
  return {
    applicationId: String(application._id),
    candidateId: String(candidate._id),
    entryUrl: directApplicationUrl(job.applicationUrl),
    candidate: plainCandidate(candidate),
    job: { title: job.title, company: job.company, description: job.description?.slice(0, 1500) },
    coverLetter: application.coverLetter,
    quickCopy: quickCopyItems(candidate, application.coverLetter, saved),
    resumeFileName: `${candidate.name.replace(/[^a-z0-9]+/gi, "_")}_${job.company.replace(/[^a-z0-9]+/gi, "_")}.pdf`,
  };
}
