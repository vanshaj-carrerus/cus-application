import { Types } from "mongoose";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { User } from "@/lib/models/User";
import type { Role } from "@/lib/models/enums";

export interface ApplyCounts {
  today: number;
  week: number;
  month: number;
  total: number;
}

export interface ApplyQueueSummary {
  /** The shared apply queue right now. */
  queue: { ready: number; inBrowser: number; needsPreparing: number };
  /** What the signed-in person has submitted. */
  me: ApplyCounts;
  /** Admins only: every team member's numbers, and which candidates got the most applications. */
  members?: Array<ApplyCounts & { userId: string; name: string }>;
  topCandidates?: Array<{ candidateId: string; name: string; week: number; total: number }>;
}

const ZERO: ApplyCounts = { today: 0, week: 0, month: 0, total: 0 };

export async function getApplyQueueSummary(userId: string, role: Role, candidateId?: string): Promise<ApplyQueueSummary> {
  await connectDB();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n: number) => new Date(startOfDay.getTime() - n * 86_400_000);
  const week = daysAgo(6);
  const month = daysAgo(29);
  const counts = (key: string) => ({
    today: { $sum: { $cond: [{ $gte: ["$appliedAt", startOfDay] }, 1, 0] } },
    week: { $sum: { $cond: [{ $gte: ["$appliedAt", week] }, 1, 0] } },
    month: { $sum: { $cond: [{ $gte: ["$appliedAt", month] }, 1, 0] } },
    total: { $sum: 1 },
    _id: key,
  });
  // A candidate login sees only their own applications, never the team's numbers.
  const scope = role === "CANDIDATE" ? { candidateId: new Types.ObjectId(candidateId) } : {};
  const applied = { appliedBy: { $exists: true }, appliedAt: { $exists: true }, ...scope };
  const isAdmin = role === "ADMIN" || role === "SUPER_ADMIN";

  const [ready, inBrowser, needsPreparing, perMember] = await Promise.all([
    Application.countDocuments({ automationStatus: "READY_TO_APPLY", ...scope }),
    Application.countDocuments({ automationStatus: { $in: ["APPLY_REQUESTED", "IN_PROGRESS"] }, ...scope }),
    Application.countDocuments({ automationStatus: "QUEUED", ...scope }),
    Application.aggregate<ApplyCounts & { _id: Types.ObjectId }>([{ $match: applied }, { $group: counts("$appliedBy") }, { $sort: { week: -1, total: -1 } }]),
  ]);

  const summary: ApplyQueueSummary = {
    queue: { ready, inBrowser, needsPreparing },
    me: perMember.find((m) => String(m._id) === userId) ?? ZERO,
  };
  if (!isAdmin) return summary;

  const [users, perCandidate] = await Promise.all([
    User.find({ _id: { $in: perMember.map((m) => m._id) } }).select("name email").lean<Array<{ _id: Types.ObjectId; name?: string; email?: string }>>(),
    Application.aggregate<{ _id: Types.ObjectId; week: number; total: number; name?: string[] }>([
      { $match: applied },
      { $group: { _id: "$candidateId", week: { $sum: { $cond: [{ $gte: ["$appliedAt", week] }, 1, 0] } }, total: { $sum: 1 } } },
      { $sort: { week: -1, total: -1 } },
      { $limit: 10 },
      { $lookup: { from: "candidates", localField: "_id", foreignField: "_id", as: "c" } },
      { $project: { week: 1, total: 1, name: "$c.name" } },
    ]),
  ]);
  const label = new Map(users.map((u) => [String(u._id), u.name || u.email || "Unknown"]));
  summary.members = perMember.map((m) => ({ userId: String(m._id), name: label.get(String(m._id)) ?? "Unknown", today: m.today, week: m.week, month: m.month, total: m.total }));
  summary.topCandidates = perCandidate.map((c) => ({ candidateId: String(c._id), name: c.name?.[0] ?? "Unknown", week: c.week, total: c.total }));
  return summary;
}
