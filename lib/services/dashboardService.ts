import { connectDB } from "@/lib/db/mongodb";
import { JobMatch } from "@/lib/models/JobMatch";
import { Application } from "@/lib/models/Application";
import { Interview } from "@/lib/models/Interview";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import type { Role } from "@/lib/models/enums";

export interface DashboardPriority {
  id: string;
  level: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string;
  why: string;
  action: string;
  entityType: "CANDIDATE" | "JOB" | "APPLICATION";
  entityId: string;
}

/**
 * Everything here is computed live from real MongoDB data — no AI call is made
 * for the command center itself (cost control, section 45). AI is only used
 * upstream to produce the match scores / analyses this reads.
 */
export async function getCommandCenter(userId: string, role: Role) {
  await connectDB();

  const since3Days = new Date(Date.now() - 3 * 86400000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const recruiterFilter = role === "RECRUITER" ? { recruiterId: userId } : {};

  const [
    highMatchCandidates,
    strongJobMatches,
    applicationsNeedingAction,
    interviewsToday,
    uncontactedCandidates,
    difficultJobs,
  ] = await Promise.all([
    JobMatch.countDocuments({ overallScore: { $gte: 85 } }),
    JobMatch.aggregate([{ $match: { overallScore: { $gte: 90 } } }, { $group: { _id: "$jobId" } }, { $count: "count" }]),
    Application.countDocuments({ ...recruiterFilter, status: { $in: ["PENDING_APPROVAL", "SUBMITTED"] } }),
    Interview.countDocuments({ scheduledAt: { $gte: startOfToday, $lte: endOfToday }, status: "SCHEDULED" }),
    Candidate.countDocuments({ lastContactedAt: { $exists: false }, createdAt: { $lte: since3Days } }),
    Job.countDocuments({ aiDifficulty: { $in: ["DIFFICULT", "VERY_DIFFICULT"] }, status: "ACTIVE" }),
  ]);

  const topMatches = await JobMatch.find({ overallScore: { $gte: 85 } })
    .sort({ overallScore: -1 })
    .limit(5)
    .populate("candidateId", "name")
    .populate("jobId", "title company");

  const priorities: DashboardPriority[] = topMatches.map((m) => {
    const candidate = m.candidateId as unknown as { _id: string; name: string };
    const job = m.jobId as unknown as { _id: string; title: string; company: string };
    return {
      id: String(m._id),
      level: m.overallScore >= 92 ? "HIGH" : "MEDIUM",
      title: `${candidate?.name ?? "Candidate"} — ${m.overallScore}% match`,
      detail: `${job?.title ?? "Job"} at ${job?.company ?? ""}`,
      why: m.explanation,
      action: m.recommendation === "STRONGLY_RECOMMEND" ? "Recommend shortlist" : "Review match",
      entityType: "CANDIDATE",
      entityId: String(candidate?._id ?? ""),
    };
  });

  const insights = [
    highMatchCandidates > 0 && `${highMatchCandidates} high-priority candidates need review`,
    (strongJobMatches[0]?.count ?? 0) > 0 && `${strongJobMatches[0].count} jobs strongly match available candidates`,
    applicationsNeedingAction > 0 && `${applicationsNeedingAction} applications require recruiter action`,
    interviewsToday > 0 && `${interviewsToday} interview${interviewsToday === 1 ? " is" : "s are"} scheduled today`,
    uncontactedCandidates > 0 && `${uncontactedCandidates} candidates have not been contacted`,
    difficultJobs > 0 && `${difficultJobs} job${difficultJobs === 1 ? " is" : "s are"} likely difficult to fill`,
  ].filter(Boolean) as string[];

  return {
    insights,
    priorities,
    stats: {
      highMatchCandidates,
      strongJobMatchCount: strongJobMatches[0]?.count ?? 0,
      applicationsNeedingAction,
      interviewsToday,
      uncontactedCandidates,
      difficultJobs,
    },
  };
}
