import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { AiAnalysis } from "@/lib/models/AiAnalysis";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { stableHash } from "@/lib/ai/hash";
import { logAiAction } from "@/lib/ai/log-action";
import { env } from "@/lib/env";

const CANDIDATE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    overview: { type: "string" },
    careerLevel: { type: "string" },
    primarySkills: { type: "array", items: { type: "string" } },
    bestFitRoles: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    potentialGaps: { type: "array", items: { type: "string" } },
    yearsOfExperience: { type: "number" },
  },
  required: ["headline", "overview", "careerLevel", "primarySkills", "bestFitRoles"],
};

interface CandidateAnalysisResult {
  headline: string;
  overview: string;
  careerLevel: string;
  primarySkills: string[];
  bestFitRoles: string[];
  strengths: string[];
  potentialGaps: string[];
  yearsOfExperience: number;
}

function buildPrompt(candidate: {
  name: string;
  skills: string[];
  experience: { title: string; company: string; description?: string }[];
  education: { institution: string; degree?: string; field?: string }[];
  certifications: string[];
  resumeText?: string;
}) {
  return `You are a recruitment intelligence engine building a candidate profile. Only use information present below — never invent employers, titles, skills, or dates that are not stated.

Name: ${candidate.name}
Skills: ${candidate.skills.join(", ") || "none listed"}
Certifications: ${candidate.certifications.join(", ") || "none listed"}

Experience:
${candidate.experience.map((e) => `- ${e.title} at ${e.company}${e.description ? `: ${e.description}` : ""}`).join("\n") || "none listed"}

Education:
${candidate.education.map((e) => `- ${e.degree ?? ""} ${e.field ?? ""} at ${e.institution}`).join("\n") || "none listed"}

${candidate.resumeText ? `Raw resume text (source of truth):\n${candidate.resumeText.slice(0, 6000)}` : ""}

Produce:
- headline: e.g. "Senior Full Stack Developer, 8 years experience"
- overview: 2-4 sentence AI-generated candidate overview
- careerLevel: one of Entry / Mid / Senior / Lead / Principal / Executive
- primarySkills: the candidate's strongest, most evidenced skills
- bestFitRoles: 2-4 job titles this candidate is well suited for
- strengths: notable strengths grounded in the resume
- potentialGaps: gaps or missing skills relative to their apparent target roles (be conservative, do not guess wildly)
- yearsOfExperience: best estimate of total professional years, based only on listed experience`;
}

export async function analyzeCandidate(candidateId: string, opts: { userId?: string; force?: boolean } = {}) {
  await connectDB();
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) throw new Error("Candidate not found");

  const inputForHash = {
    skills: candidate.skills,
    experience: candidate.experience,
    education: candidate.education,
    resumeText: candidate.resumeText,
  };
  const inputHash = stableHash(inputForHash);

  if (!opts.force) {
    const cached = await AiAnalysis.findOne({ candidateId: candidate._id, type: "CANDIDATE_ANALYSIS", inputHash, status: "COMPLETED" }).sort({ createdAt: -1 });
    if (cached?.output) return cached.output as unknown as CandidateAnalysisResult;
  }

  const analysisDoc = await AiAnalysis.create({
    type: "CANDIDATE_ANALYSIS",
    candidateId: candidate._id,
    input: inputForHash,
    inputHash,
    aiModel: env.aiModel,
    status: "PROCESSING",
  });

  try {
    const result = await AiApiAdapter.structuredOutput<CandidateAnalysisResult>(buildPrompt(candidate), {
      schema: CANDIDATE_ANALYSIS_SCHEMA,
      systemInstruction: "You are an expert technical recruiter. Never invent facts not present in the source text.",
    });

    candidate.aiProfile = {
      headline: result.headline,
      overview: result.overview,
      careerLevel: result.careerLevel,
      primarySkills: result.primarySkills,
      bestFitRoles: result.bestFitRoles,
      strengths: result.strengths,
      potentialGaps: result.potentialGaps,
      yearsOfExperience: result.yearsOfExperience,
      analyzedAt: new Date(),
      model: env.aiModel,
    };
    candidate.careerLevel = result.careerLevel;
    if (result.yearsOfExperience) candidate.yearsOfExperience = result.yearsOfExperience;
    await candidate.save();

    analysisDoc.output = result as unknown as Record<string, unknown>;
    analysisDoc.status = "COMPLETED";
    await analysisDoc.save();

    await logAiAction({
      userId: opts.userId,
      action: "AI_CANDIDATE_ANALYZED",
      entityType: "Candidate",
      entityId: candidate._id,
    });

    return result;
  } catch (err) {
    analysisDoc.status = "FAILED";
    analysisDoc.error = err instanceof Error ? err.message : String(err);
    await analysisDoc.save();
    throw err;
  }
}
