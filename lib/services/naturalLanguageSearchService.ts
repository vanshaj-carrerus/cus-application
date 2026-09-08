import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";

/**
 * AI converts natural language into a structured filter object; MongoDB performs
 * the actual query. The AI never sees or returns database rows — it only produces
 * filter parameters, so it cannot hallucinate results.
 */

const CANDIDATE_FILTER_SCHEMA = {
  type: "object",
  properties: {
    skills: { type: "array", items: { type: "string" } },
    location: { type: "string" },
    minYearsExperience: { type: "number" },
    maxYearsExperience: { type: "number" },
    careerLevel: { type: "string" },
    availableWithinDays: { type: "number" },
  },
};

interface CandidateFilters {
  skills?: string[];
  location?: string;
  minYearsExperience?: number;
  maxYearsExperience?: number;
  careerLevel?: string;
  availableWithinDays?: number;
}

export async function naturalLanguageCandidateSearch(query: string, opts: { userId?: string } = {}) {
  await connectDB();

  const filters = await AiApiAdapter.structuredOutput<CandidateFilters>(
    `Convert this recruiter search request into structured filters: "${query}"`,
    { schema: CANDIDATE_FILTER_SCHEMA, systemInstruction: "Extract only what is stated or clearly implied. Do not add unstated constraints." }
  );

  const mongoFilter: Record<string, unknown> = {};
  if (filters.skills?.length) {
    mongoFilter.skills = { $in: filters.skills.map((s) => new RegExp(s, "i")) };
  }
  if (filters.location) {
    mongoFilter.location = new RegExp(filters.location, "i");
  }
  if (filters.minYearsExperience != null || filters.maxYearsExperience != null) {
    mongoFilter.yearsOfExperience = {};
    if (filters.minYearsExperience != null) (mongoFilter.yearsOfExperience as Record<string, number>).$gte = filters.minYearsExperience;
    if (filters.maxYearsExperience != null) (mongoFilter.yearsOfExperience as Record<string, number>).$lte = filters.maxYearsExperience;
  }
  if (filters.careerLevel) {
    mongoFilter.careerLevel = new RegExp(filters.careerLevel, "i");
  }

  const candidates = await Candidate.find(mongoFilter).limit(50).sort({ updatedAt: -1 });

  await logAiAction({
    userId: opts.userId,
    action: "AI_SEARCH_PERFORMED",
    tool: "naturalLanguageCandidateSearch",
    input: { query },
    output: { filters: filters as Record<string, unknown>, resultCount: candidates.length },
  });

  return { filters, candidates };
}

const JOB_FILTER_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    location: { type: "string" },
    remote: { type: "boolean" },
    seniority: { type: "string" },
    postedWithinDays: { type: "number" },
  },
};

interface JobFilters {
  title?: string;
  location?: string;
  remote?: boolean;
  seniority?: string;
  postedWithinDays?: number;
}

export async function naturalLanguageJobSearch(query: string, opts: { userId?: string } = {}) {
  await connectDB();

  const filters = await AiApiAdapter.structuredOutput<JobFilters>(
    `Convert this recruiter search request into structured job filters: "${query}"`,
    { schema: JOB_FILTER_SCHEMA, systemInstruction: "Extract only what is stated or clearly implied." }
  );

  const mongoFilter: Record<string, unknown> = { status: "ACTIVE" };
  if (filters.title) mongoFilter.title = new RegExp(filters.title, "i");
  if (filters.location) mongoFilter.location = new RegExp(filters.location, "i");
  if (filters.remote) mongoFilter.remoteType = "REMOTE";
  if (filters.postedWithinDays) {
    mongoFilter.postedAt = { $gte: new Date(Date.now() - filters.postedWithinDays * 86400000) };
  }

  const jobs = await Job.find(mongoFilter).limit(50).sort({ postedAt: -1 });

  await logAiAction({
    userId: opts.userId,
    action: "AI_SEARCH_PERFORMED",
    tool: "naturalLanguageJobSearch",
    input: { query },
    output: { filters: filters as Record<string, unknown>, resultCount: jobs.length },
  });

  return { filters, jobs };
}
