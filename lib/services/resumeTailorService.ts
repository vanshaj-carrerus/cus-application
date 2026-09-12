import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { tailorResume as rewriteResumeText } from "@/lib/services/resumeService";
import { tailorForJob } from "@/lib/services/aiTailor";
import { buildResumeHtml } from "@/lib/services/resumeTemplate";
import { renderAndStorePdf } from "@/lib/services/pdfGenerator";
import { playwrightApplyQueue } from "@/lib/queue/queues";
import { logAiAction } from "@/lib/ai/log-action";

/**
 * Stage 2 of the auto-apply pipeline. Consumes the Application stubbed out by
 * Stage 1 (status PENDING_MATCHING) and produces a tailored, ATS-formatted resume
 * PDF plus a cover letter, then hands off to the Playwright apply stage.
 */
export async function tailorApplicationForJob(applicationId: string) {
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

  await playwrightApplyQueue().add("apply", {
    applicationId: String(application._id),
    candidateId: String(candidate._id),
    jobId: String(job._id),
  });

  return { applicationId: String(application._id), resumeId: String(resume._id), pdfUrl: pdf.url };
}
