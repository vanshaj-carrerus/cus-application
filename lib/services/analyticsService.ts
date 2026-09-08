import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { Candidate } from "@/lib/models/Candidate";
import { Application } from "@/lib/models/Application";
import { Interview } from "@/lib/models/Interview";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";

export interface RecruitmentMetrics {
  jobsImported: number;
  candidates: number;
  applications: number;
  interviews: number;
  offers: number;
  hires: number;
  matchRate: number; // applications / (candidates considered) — simplified proxy
  interviewRate: number; // interviews / applications
  offerRate: number; // offers / interviews
  hireRate: number; // hires / offers
}

export async function computeRecruitmentMetrics(): Promise<RecruitmentMetrics> {
  await connectDB();

  const [jobsImported, candidates, applications, interviews, offers, hires] = await Promise.all([
    Job.countDocuments({}),
    Candidate.countDocuments({}),
    Application.countDocuments({}),
    Interview.countDocuments({}),
    Application.countDocuments({ status: "OFFER" }),
    Application.countDocuments({ status: "HIRED" }),
  ]);

  return {
    jobsImported,
    candidates,
    applications,
    interviews,
    offers,
    hires,
    matchRate: candidates > 0 ? Math.round((applications / candidates) * 1000) / 10 : 0,
    interviewRate: applications > 0 ? Math.round((interviews / applications) * 1000) / 10 : 0,
    offerRate: interviews > 0 ? Math.round((offers / interviews) * 1000) / 10 : 0,
    hireRate: offers > 0 ? Math.round((hires / offers) * 1000) / 10 : 0,
  };
}

export async function computeRecruitmentAnalytics() {
  const metrics = await computeRecruitmentMetrics();

  const topSkills = await Job.aggregate([
    { $unwind: "$skills" },
    { $group: { _id: "$skills", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10},
  ]);

  const hardestJobs = await Job.find({ aiDifficulty: { $in: ["DIFFICULT", "VERY_DIFFICULT"] } })
    .select("title company aiDifficulty aiDifficultyReasoning")
    .limit(10);

  return { metrics, topSkills, hardestJobs, computedAt: new Date() };
}

export async function generateAiInsights(metrics: RecruitmentMetrics, context: { topSkills?: unknown[]; hardestJobs?: unknown[] } = {}) {
  const prompt = `Given these real recruitment metrics from our database, explain what stands out and give 2-3 concrete recommendations. Do not invent numbers not given here.

Metrics: ${JSON.stringify(metrics)}
Top in-demand skills: ${JSON.stringify(context.topSkills ?? [])}
Hardest jobs to fill: ${JSON.stringify(context.hardestJobs ?? [])}

Answer briefly, in plain prose, addressed to a recruiting team lead.`;

  return AiApiAdapter.analyze(prompt, { temperature: 0.4 });
}
