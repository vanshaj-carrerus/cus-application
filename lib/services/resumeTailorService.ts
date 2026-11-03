import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { tailorResume as rewriteResumeText } from "@/lib/services/resumeService";
import { tailorForJob } from "@/lib/services/aiTailor";
import { buildResumeHtml } from "@/lib/services/resumeTemplate";
import { renderAndStorePdf } from "@/lib/services/pdfGenerator";
import { logAiAction } from "@/lib/ai/log-action";
import { tailorLimiter } from "@/lib/concurrency/limiter";

/**
 * Stage 2 of the application pipeline. Consumes the Application stubbed out by
 * Stage 1 (status PENDING_MATCHING) and produces a tailored, ATS-formatted resume
 * PDF plus a cover letter, then marks it READY_TO_APPLY. A marketer takes it from
 * there: they click Apply in the app and the assistant browser fills the form.
 */
export function tailorApplicationForJob(applicationId: string) {
  // Across every request in this server, only TAILOR_GLOBAL_CONCURRENCY run at once; the rest queue.
  return tailorLimiter().run(() => tailorApplicationForJobNow(applicationId));
}

async function tailorApplicationForJobNow(applicationId: string) {
  await connectDB();

  const application = await Application.findById(applicationId);
  if (!application) throw new Error(`Application ${applicationId} not found`);

  const [candidate, job] = await Promise.all([Candidate.findById(application.candidateId), Job.findById(application.jobId)]);
  if (!candidate) throw new Error(`Candidate ${application.candidateId} not found`);
  if (!job) throw new Error(`Job ${application.jobId} not found`);

  // Full resume body reorganization (existing Gemini-backed service) + the
  // Claude-backed summary/skills/cover-letter pass required by this stage.
  const [resume, tailored] = await Promise.all([rewriteResumeText(String(candidate._id), String(job._id)), tailorForJob(candidate, job)]);

  const html = buildResumeHtml(candidate, tailored.adjustedSummary, tailored.highlightedSkills, resume.tailoredContent ?? resume.extractedText);
  const pdf = await renderAndStorePdf(html, `resumes/${candidate._id}`);

  resume.fileUrl = pdf.url;
  resume.fileType = "GENERATED";
  await resume.save();

  application.resumeVersionId = resume._id;
  application.coverLetter = tailored.coverLetter;
  application.status = "TAILORED";
  application.automationStatus = "READY_TO_APPLY";
  application.failureReason = undefined;
  application.timeline.push({ status: "TAILORED", note: "AI-tailored resume and cover letter generated", changedAt: new Date() });
  await application.save();

  await logAiAction({
    action: "AI_RESUME_GENERATED",
    entityType: "Application",
    entityId: application._id,
    input: { candidateId: String(candidate._id), jobId: String(job._id) },
    output: { resumeId: String(resume._id), pdfUrl: pdf.url },
  });
  await logAiAction({
    action: "AI_COVER_LETTER_GENERATED",
    entityType: "Application",
    entityId: application._id,
  });

  return { applicationId: String(application._id), resumeId: String(resume._id), pdfUrl: pdf.url };
}

export interface PrepareProgress {
  applicationId: string;
  ok: boolean;
  title?: string;
  company?: string;
  error?: string;
}

/**
 * Prepares several applications inside the current request, a few at a time (each one is an AI call plus a PDF
 * render). One failure never stops the rest: it's reported, the application stays QUEUED with the reason, and the
 * apply queue offers a "Prepare now" retry.
 */
export async function prepareApplications(ids: string[], onEach?: (p: PrepareProgress) => void | Promise<void>, concurrency = Number(process.env.TAILOR_CONCURRENCY) || 3) {
  const queue = [...ids];
  let prepared = 0;
  let failed = 0;
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const progress: PrepareProgress = { applicationId: id, ok: true };
      try {
        await tailorApplicationForJob(id);
      } catch (err) {
        progress.ok = false;
        progress.error = err instanceof Error ? err.message : String(err);
        await Application.updateOne({ _id: id }, { $set: { failureReason: `Could not prepare: ${progress.error}` } }).catch(() => undefined);
      }
      const application = await Application.findById(id).select("jobId").populate<{ jobId: { title?: string; company?: string } | null }>("jobId", "title company").lean();
      progress.title = application?.jobId?.title;
      progress.company = application?.jobId?.company;
      if (progress.ok) prepared++;
      else failed++;
      await onEach?.(progress);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return { prepared, failed };
}
