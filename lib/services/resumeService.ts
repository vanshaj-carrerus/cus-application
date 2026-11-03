import { connectDB } from "@/lib/db/mongodb";
import { Resume } from "@/lib/models/Resume";
import { Candidate, type ICandidate } from "@/lib/models/Candidate";
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

/**
 * Plain-text resume source built from the structured profile, for candidates with no uploaded resume.
 * Returns "" when the profile has no experience, education or skills (nothing real to write from).
 */
export function buildResumeTextFromProfile(candidate: ICandidate): string {
  const lines: string[] = [];
  const section = (title: string, body: string[]) => {
    if (body.length) lines.push("", title.toUpperCase(), ...body);
  };
  const range = (start?: string, end?: string, current?: boolean) => [start, current ? "Present" : end].filter(Boolean).join(" - ");

  const experience = (candidate.experience ?? []).filter((e) => e.title || e.company);
  const education = (candidate.education ?? []).filter((e) => e.institution);
  const skills = [...new Set([...(candidate.skills ?? []), ...(candidate.technicalSkills ?? []), ...(candidate.softSkills ?? [])])];
  if (experience.length === 0 && education.length === 0 && skills.length === 0) return "";

  lines.push(candidate.name);
  if (candidate.aiProfile?.headline) lines.push(candidate.aiProfile.headline);
  const facts = [candidate.yearsOfExperience != null ? `${candidate.yearsOfExperience} years of experience` : "", candidate.careerLevel, candidate.location].filter(Boolean);
  if (facts.length) lines.push(facts.join(" | "));

  section("Summary", candidate.aiProfile?.overview ? [candidate.aiProfile.overview] : []);
  section("Skills", skills.length ? [skills.join(", ")] : []);
  section(
    "Experience",
    experience.flatMap((e) => {
      const when = range(e.startDate, e.endDate, e.isCurrent);
      return [`${[e.title, e.company].filter(Boolean).join(", ")}${when ? ` (${when})` : ""}`, ...(e.description ? [e.description] : []), ""];
    })
  );
  section(
    "Education",
    education.map((e) => {
      const when = range(e.startDate, e.endDate);
      return `${[e.degree, e.field].filter(Boolean).join(" in ")}${e.degree || e.field ? ", " : ""}${e.institution}${when ? ` (${when})` : ""}`;
    })
  );
  section("Projects", (candidate.projects ?? []).filter((p) => p.name).map((p) => `${p.name}${p.description ? `: ${p.description}` : ""}`));
  section("Certifications", candidate.certifications ?? []);
  return lines.join("\n").trim();
}

export async function tailorResume(candidateId: string, jobId: string, opts: { userId?: string } = {}) {
  await connectDB();
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate) throw new Error("Candidate not found");
  if (!job) throw new Error("Job not found");
  // No uploaded resume: write from what the profile holds (experience, education, skills...). The same
  // "never invent anything" rule applies, so a thin profile gives a short resume, not a padded one.
  const sourceText = candidate.resumeText?.trim() || buildResumeTextFromProfile(candidate);
  if (!sourceText) throw new Error("This candidate has no resume uploaded and no profile details (experience, education or skills) to build one from. Add some under Edit Details.");

  const lastVersion = await Resume.findOne({ candidateId }).sort({ version: -1 });
  const nextVersion = (lastVersion?.version ?? 0) + 1;

  const prompt = `Rewrite and reorganize the following resume to emphasize the experience most relevant to the target job. You may NOT invent companies, skills, experience, education, certifications, achievements, dates, or job titles that are not already present in the source resume. You may only reorder, re-emphasize, and rephrase truthful existing content.

Write as the candidate speaking about themselves in first person (e.g. "I led...", "I managed..."). Never refer to the candidate by name or in third person (e.g. never write "${candidate.name} is..." or "${candidate.name} has..."). A resume is something the candidate writes about themselves, not something written about them.

SOURCE RESUME${candidate.resumeText?.trim() ? "" : " (assembled from the candidate's profile, since no resume file was uploaded)"} (ground truth — do not add facts beyond this):
${sourceText.slice(0, 8000)}

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
    extractedText: sourceText,
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
