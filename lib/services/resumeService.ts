import { connectDB } from "@/lib/db/mongodb";
import { Resume } from "@/lib/models/Resume";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";

const RESUME_QUALITY_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    atsCompatibility: { type: "number" },
    missingInformation: { type: "array", items: { type: "string" } },
    skillsClarity: { type: "string" },
    experienceClarity: { type: "string" },
    formattingProblems: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
  },
  required: ["score", "atsCompatibility", "improvements"],
};

interface ResumeQualityResult {
  score: number;
  atsCompatibility: number;
  missingInformation: string[];
  skillsClarity: string;
  experienceClarity: string;
  formattingProblems: string[];
  improvements: string[];
}

export async function analyzeResumeQuality(resumeId: string, opts: { userId?: string } = {}) {
  await connectDB();
  const resume = await Resume.findById(resumeId);
  if (!resume) throw new Error("Resume not found");

  const prompt = `Evaluate the quality of this resume as an ATS and recruiter would. Be specific and only reference what is actually in the text.

Resume text:
${resume.extractedText.slice(0, 8000)}

Produce:
- score: overall resume quality 0-100
- atsCompatibility: 0-100 estimate of how well an ATS would parse this
- missingInformation: important sections/fields that appear to be missing (e.g. contact info, dates)
- skillsClarity: short assessment of how clearly skills are presented
- experienceClarity: short assessment of how clearly experience is presented
- formattingProblems: concrete formatting issues if any
- improvements: concrete, actionable suggestions to improve the resume`;

  const result = await AiApiAdapter.structuredOutput<ResumeQualityResult>(prompt, {
    schema: RESUME_QUALITY_SCHEMA,
    systemInstruction: "You are an ATS and resume quality expert.",
  });

  resume.aiQuality = { ...result, analyzedAt: new Date() };
  await resume.save();

  await logAiAction({
    userId: opts.userId,
    action: "AI_RESUME_ANALYZED",
    entityType: "Resume",
    entityId: resume._id,
    output: { score: result.score },
  });

  return result;
}

export async function tailorResume(candidateId: string, jobId: string, opts: { userId?: string } = {}) {
  await connectDB();
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate) throw new Error("Candidate not found");
  if (!job) throw new Error("Job not found");
  if (!candidate.resumeText) throw new Error("Candidate has no base resume text to tailor");

  const lastVersion = await Resume.findOne({ candidateId }).sort({ version: -1 });
  const nextVersion = (lastVersion?.version ?? 0) + 1;

  const prompt = `Rewrite and reorganize the following resume to emphasize the experience most relevant to the target job. You may NOT invent companies, skills, experience, education, certifications, achievements, dates, or job titles that are not already present in the source resume. You may only reorder, re-emphasize, and rephrase truthful existing content.

Write as the candidate speaking about themselves in first person (e.g. "I led...", "I managed..."). Never refer to the candidate by name or in third person (e.g. never write "${candidate.name} is..." or "${candidate.name} has..."). A resume is something the candidate writes about themselves, not something written about them.

SOURCE RESUME (ground truth — do not add facts beyond this):
${candidate.resumeText.slice(0, 8000)}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Required skills: ${job.skills.join(", ")}
Description: ${job.description.slice(0, 2000)}

Return only the tailored resume text, well formatted in plain text with clear section headers.`;

  const tailoredContent = await AiApiAdapter.generate(prompt, {
    systemInstruction: "You are an expert resume writer. You never invent facts. You only reorganize and emphasize truthful existing content.",
    temperature: 0.3,
    maxOutputTokens: 3000,
  });

  const resume = await Resume.create({
    candidateId,
    jobId,
    version: nextVersion,
    label: `v${nextVersion} — ${job.title} @ ${job.company}`,
    extractedText: candidate.resumeText,
    tailoredContent,
    isTailored: true,
    fileType: "GENERATED",
    createdBy: opts.userId,
  });

  await logAiAction({
    userId: opts.userId,
    action: "AI_RESUME_GENERATED",
    entityType: "Resume",
    entityId: resume._id,
    input: { candidateId, jobId },
  });

  return resume;
}
