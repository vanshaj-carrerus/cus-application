import type { ICandidate } from "@/lib/models/Candidate";
import type { IJob } from "@/lib/models/Job";
import { runJsonPrompt } from "@/lib/adapters/multiProviderAdapter";

/**
 * Stage 2 of the auto-apply pipeline: given a candidate's structured profile and a
 * raw job description, ask an LLM for the pieces a human resume writer would adjust
 * per application — a punchier summary, which existing skills to foreground, and a
 * cover letter — without touching the underlying facts of the resume itself
 * (full resume reorganization is handled separately by resumeService.tailorResume).
 * Runs through the Gemini -> Mistral -> Groq -> OpenRouter fallback chain, so the
 * required JSON shape is spelled out in the prompt itself rather than enforced via
 * a provider-side schema.
 */

export interface AiTailorResult {
  adjustedSummary: string;
  highlightedSkills: string[];
  coverLetter: string;
}

function candidateExperienceJson(candidate: ICandidate) {
  return JSON.stringify(
    {
      name: candidate.name,
      headline: candidate.aiProfile?.headline,
      yearsOfExperience: candidate.yearsOfExperience,
      careerLevel: candidate.careerLevel,
      skills: candidate.skills,
      technicalSkills: candidate.technicalSkills,
      experience: candidate.experience,
      education: candidate.education,
      certifications: candidate.certifications,
    },
    null,
    2
  );
}

export async function tailorForJob(candidate: ICandidate, job: IJob): Promise<AiTailorResult> {
  const prompt = `You are an expert resume writer and ATS optimization specialist tailoring a job application. Use ONLY facts present in the candidate profile JSON below — never invent skills, employers, titles, dates, or achievements the candidate doesn't already have. You only reorganize, re-emphasize, and rephrase what is already true.

CANDIDATE PROFILE (ground truth):
${candidateExperienceJson(candidate)}

RAW JOB DESCRIPTION:
Title: ${job.title}
Company: ${job.company}
${job.description.slice(0, 6000)}

Respond with ONLY a JSON object (no markdown fences, no commentary) with exactly these fields:
{
  "adjustedSummary": "a 2-4 sentence resume summary rewritten to emphasize the candidate's real experience most relevant to this job",
  "highlightedSkills": ["subset of the candidate's own listed skills only, ordered by relevance to this job's requirements/keywords"],
  "coverLetter": "a genuine 3-4 paragraph cover letter referencing real details from both the candidate profile and the job description, no placeholder brackets"
}`;

  const { data: result } = await runJsonPrompt<AiTailorResult>(prompt);

  // Defensive: only keep skills that actually exist on the candidate, in case the
  // model paraphrases instead of copying verbatim.
  const candidateSkillsLower = new Set([...candidate.skills, ...candidate.technicalSkills].map((s) => s.toLowerCase()));
  const highlightedSkills = result.highlightedSkills.filter((s) => candidateSkillsLower.has(s.toLowerCase()));

  return { ...result, highlightedSkills: highlightedSkills.length > 0 ? highlightedSkills : result.highlightedSkills };
}
