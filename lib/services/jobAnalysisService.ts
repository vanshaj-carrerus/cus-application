import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { AiAnalysis } from "@/lib/models/AiAnalysis";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { stableHash } from "@/lib/ai/hash";
import { logAiAction } from "@/lib/ai/log-action";
import { env } from "@/lib/env";

const JOB_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    mustHaveSkills: { type: "array", items: { type: "string" } },
    niceToHaveSkills: { type: "array", items: { type: "string" } },
    hiddenRequirements: { type: "array", items: { type: "string" } },
    screeningQuestions: { type: "array", items: { type: "string" } },
    searchKeywords: { type: "array", items: { type: "string" } },
    seniority: { type: "string" },
    industry: { type: "string" },
    qualityScore: { type: "number" },
    qualityBreakdown: {
      type: "object",
      properties: {
        descriptionQuality: { type: "number" },
        skillClarity: { type: "number" },
        experienceClarity: { type: "number" },
        salaryTransparency: { type: "number" },
        locationClarity: { type: "number" },
        requirementClarity: { type: "number" },
      },
    },
    qualityIssues: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "mustHaveSkills", "qualityScore", "qualityIssues"],
};

interface JobAnalysisResult {
  summary: string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  hiddenRequirements: string[];
  screeningQuestions: string[];
  searchKeywords: string[];
  seniority: string;
  industry: string;
  qualityScore: number;
  qualityBreakdown: Record<string, number>;
  qualityIssues: string[];
}

function buildPrompt(job: { title: string; company: string; description: string; skills: string[]; location?: string; salaryMin?: number; salaryMax?: number; experienceMin?: number; experienceMax?: number }) {
  return `You are a recruitment intelligence engine analyzing a real job posting. Only use information present in the posting below — never invent facts. When you infer something not explicitly stated (e.g. a "hidden requirement"), phrase it as an inference, not a fact.

Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? "Not specified"}
Salary: ${job.salaryMin ?? "?"} - ${job.salaryMax ?? "?"}
Listed experience: ${job.experienceMin ?? "?"} - ${job.experienceMax ?? "?"} years
Listed skills: ${job.skills.join(", ") || "none listed"}

Description:
${job.description}

Produce:
- summary: a short recruiter-friendly explanation of the role (2-4 sentences)
- mustHaveSkills: critical requirements explicitly stated
- niceToHaveSkills: optional/preferred requirements
- hiddenRequirements: requirements you infer but that are not explicit (label these as inferred in the text itself)
- screeningQuestions: 5 useful recruiter screening questions
- searchKeywords: keywords a recruiter could use to search for matching candidates
- seniority: one of Junior / Mid / Senior / Lead / Principal / Unknown
- industry: best-guess industry
- qualityScore: 0-100 score for how complete/clear this posting is
- qualityBreakdown: sub-scores 0-100 for descriptionQuality, skillClarity, experienceClarity, salaryTransparency, locationClarity, requirementClarity
- qualityIssues: concrete issues, e.g. "Salary range is missing.", "Experience requirement is ambiguous."`;
}

export async function analyzeJob(jobId: string, opts: { userId?: string; force?: boolean } = {}) {
  await connectDB();
  const job = await Job.findById(jobId);
  if (!job) throw new Error("Job not found");

  const inputForHash = { title: job.title, description: job.description, skills: job.skills };
  const inputHash = stableHash(inputForHash);

  if (!opts.force) {
    const cached = await AiAnalysis.findOne({ jobId: job._id, type: "JOB_ANALYSIS", inputHash, status: "COMPLETED" }).sort({ createdAt: -1 });
    if (cached?.output) {
      return cached.output as unknown as JobAnalysisResult;
    }
  }

  const analysisDoc = await AiAnalysis.create({
    type: "JOB_ANALYSIS",
    jobId: job._id,
    input: inputForHash,
    inputHash,
    aiModel: env.aiModel,
    status: "PROCESSING",
  });

  try {
    const result = await AiApiAdapter.structuredOutput<JobAnalysisResult>(buildPrompt(job), {
      schema: JOB_ANALYSIS_SCHEMA,
      systemInstruction: "You are an expert technical recruiter. Never invent facts not present in the source text.",
    });

    job.aiAnalysis = {
      summary: result.summary,
      mustHaveSkills: result.mustHaveSkills,
      niceToHaveSkills: result.niceToHaveSkills,
      hiddenRequirements: (result.hiddenRequirements || []).map((text) => ({ text, inferred: true as const })),
      screeningQuestions: result.screeningQuestions,
      searchKeywords: result.searchKeywords,
      seniority: result.seniority,
      industry: result.industry,
      qualityScore: result.qualityScore,
      qualityBreakdown: result.qualityBreakdown,
      qualityIssues: result.qualityIssues,
      analyzedAt: new Date(),
      model: env.aiModel,
    };
    job.aiScore = result.qualityScore;
    await job.save();

    analysisDoc.output = result as unknown as Record<string, unknown>;
    analysisDoc.score = result.qualityScore;
    analysisDoc.status = "COMPLETED";
    await analysisDoc.save();

    await logAiAction({
      userId: opts.userId,
      action: "AI_JOB_ANALYZED",
      entityType: "Job",
      entityId: job._id,
      output: { qualityScore: result.qualityScore },
    });

    return result;
  } catch (err) {
    analysisDoc.status = "FAILED";
    analysisDoc.error = err instanceof Error ? err.message : String(err);
    await analysisDoc.save();
    throw err;
  }
}
