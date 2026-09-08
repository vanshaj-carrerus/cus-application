import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { JobMatch } from "@/lib/models/JobMatch";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";
import { env } from "@/lib/env";
import { RECOMMENDATIONS } from "@/lib/models/enums";

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    overallScore: { type: "number" },
    skillMatch: { type: "number" },
    experienceMatch: { type: "number" },
    locationMatch: { type: "number" },
    educationMatch: { type: "number" },
    seniorityMatch: { type: "number" },
    salaryMatch: { type: "number" },
    matchingSkills: { type: "array", items: { type: "string" } },
    missingSkills: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
    riskFactors: { type: "array", items: { type: "string" } },
    recommendation: { type: "string", enum: [...RECOMMENDATIONS] },
    explanation: { type: "string" },
  },
  required: ["overallScore", "skillMatch", "experienceMatch", "recommendation", "explanation"],
};

interface MatchResult {
  overallScore: number;
  skillMatch: number;
  experienceMatch: number;
  locationMatch: number;
  educationMatch: number;
  seniorityMatch: number;
  salaryMatch: number;
  matchingSkills: string[];
  missingSkills: string[];
  strengths: string[];
  concerns: string[];
  riskFactors: string[];
  recommendation: (typeof RECOMMENDATIONS)[number];
  explanation: string;
}

function buildPrompt(candidate: InstanceType<typeof Candidate>, job: InstanceType<typeof Job>) {
  return `Compare this candidate against this job and produce a detailed, explainable match analysis. Ground every claim in the data given — never invent candidate or job facts.

CANDIDATE
Name: ${candidate.name}
Skills: ${candidate.skills.join(", ") || "none listed"}
Years of experience: ${candidate.yearsOfExperience ?? "unknown"}
Career level: ${candidate.careerLevel ?? "unknown"}
Location: ${candidate.location ?? "unknown"}
Preferred locations: ${candidate.preferredLocations.join(", ") || "any"}
Expected salary: ${candidate.expectedSalary ?? "not specified"}
Education: ${candidate.education.map((e) => `${e.degree ?? ""} ${e.field ?? ""}`).join("; ") || "not specified"}
Experience:
${candidate.experience.map((e) => `- ${e.title} at ${e.company}`).join("\n") || "none listed"}

JOB
Title: ${job.title}
Company: ${job.company}
Required skills: ${job.skills.join(", ") || "none listed"}
Must-have (from AI analysis): ${job.aiAnalysis?.mustHaveSkills?.join(", ") || "n/a"}
Experience required: ${job.experienceMin ?? "?"} - ${job.experienceMax ?? "?"} years
Seniority: ${job.aiAnalysis?.seniority ?? "unknown"}
Location: ${job.location ?? "unknown"} (remote type: ${job.remoteType})
Salary: ${job.salaryMin ?? "?"} - ${job.salaryMax ?? "?"} ${job.currency ?? ""}
Education requirements: ${job.qualifications.join("; ") || "not specified"}

Score each dimension 0-100 and give an overall 0-100 score (not necessarily an average — weight skills and experience most heavily). Provide matchingSkills / missingSkills, strengths, concerns, riskFactors, a recommendation (one of STRONGLY_RECOMMEND, RECOMMEND, REVIEW, WEAK_MATCH, DO_NOT_RECOMMEND) and a 2-4 sentence explanation that justifies the score in specific, concrete terms (e.g. "Candidate has 7 of 8 critical skills and exceeds required experience by 2 years").`;
}

export async function matchCandidateToJob(candidateId: string, jobId: string, opts: { userId?: string; force?: boolean } = {}) {
  await connectDB();
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate) throw new Error("Candidate not found");
  if (!job) throw new Error("Job not found");

  if (!opts.force) {
    const existing = await JobMatch.findOne({ candidateId, jobId });
    if (existing) return existing;
  }

  const result = await AiApiAdapter.structuredOutput<MatchResult>(buildPrompt(candidate, job), {
    schema: MATCH_SCHEMA,
    systemInstruction: "You are an expert technical recruiter producing explainable candidate-job match scores. Never fabricate candidate or job attributes.",
  });

  const match = await JobMatch.findOneAndUpdate(
    { candidateId, jobId },
    {
      candidateId,
      jobId,
      overallScore: result.overallScore,
      skillMatch: result.skillMatch,
      experienceMatch: result.experienceMatch,
      locationMatch: result.locationMatch ?? 0,
      educationMatch: result.educationMatch ?? 0,
      seniorityMatch: result.seniorityMatch ?? 0,
      salaryMatch: result.salaryMatch ?? 0,
      matchingSkills: result.matchingSkills ?? [],
      missingSkills: result.missingSkills ?? [],
      strengths: result.strengths ?? [],
      concerns: result.concerns ?? [],
      riskFactors: result.riskFactors ?? [],
      recommendation: result.recommendation,
      explanation: result.explanation,
      aiModel: env.aiModel,
    },
    { upsert: true, new: true }
  );

  await logAiAction({
    userId: opts.userId,
    action: "AI_MATCH_CREATED",
    entityType: "JobMatch",
    entityId: match._id,
    output: { overallScore: result.overallScore, recommendation: result.recommendation },
  });

  return match;
}

export async function bulkMatchCandidatesToJob(jobId: string, candidateIds: string[], opts: { userId?: string } = {}) {
  const results = [];
  for (const candidateId of candidateIds) {
    try {
      results.push(await matchCandidateToJob(candidateId, jobId, opts));
    } catch (err) {
      console.error(`Failed to match candidate ${candidateId} to job ${jobId}:`, err);
    }
  }
  return results;
}
