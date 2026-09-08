import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { Candidate } from "@/lib/models/Candidate";
import { logAiAction } from "@/lib/ai/log-action";
import type { JobDifficulty } from "@/lib/models/enums";

/**
 * Rule-based difficulty estimate from the actual candidate pool in MongoDB
 * (not an AI guess) — counts candidates whose skills/location plausibly overlap.
 * This keeps the "estimate" honest and grounded in real platform data per the
 * AI guardrails (never fabricate availability numbers).
 */
export async function predictJobDifficulty(jobId: string, opts: { userId?: string } = {}) {
  await connectDB();
  const job = await Job.findById(jobId);
  if (!job) throw new Error("Job not found");

  const skillRegexes = job.skills.slice(0, 8).map((s) => new RegExp(s, "i"));

  const [strongMatches, potentialMatches, totalCandidates] = await Promise.all([
    Candidate.countDocuments({
      skills: { $in: skillRegexes },
      ...(job.city ? { location: new RegExp(job.city, "i") } : {}),
    }),
    Candidate.countDocuments({ skills: { $in: skillRegexes } }),
    Candidate.countDocuments({}),
  ]);

  let difficulty: JobDifficulty;
  let reasoning: string;

  if (strongMatches >= 15) {
    difficulty = "EASY";
    reasoning = `${strongMatches} candidates in the pool closely match this job's skills and location.`;
  } else if (potentialMatches >= 20) {
    difficulty = "MODERATE";
    reasoning = `${potentialMatches} candidates match on skills, but only ${strongMatches} also match location — moderate availability.`;
  } else if (potentialMatches >= 5) {
    difficulty = "DIFFICULT";
    reasoning = `Only ${potentialMatches} candidates in the current pool match this job's required skills.`;
  } else {
    difficulty = "VERY_DIFFICULT";
    reasoning = `Fewer than 5 candidates in the current pool of ${totalCandidates} match this job's required skills.`;
  }

  job.aiDifficulty = difficulty;
  job.aiDifficultyReasoning = `${reasoning} This is an estimate based on the current candidate database, not a guarantee.`;
  await job.save();

  await logAiAction({
    userId: opts.userId,
    action: "AI_JOB_DIFFICULTY_PREDICTED",
    entityType: "Job",
    entityId: job._id,
    output: { difficulty, strongMatches, potentialMatches },
  });

  return { difficulty, reasoning: job.aiDifficultyReasoning, strongMatches, potentialMatches, totalCandidates };
}
