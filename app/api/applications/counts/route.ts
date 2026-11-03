import { NextResponse, type NextRequest } from "next/server";
import { Types } from "mongoose";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";

/** Where one candidate's applications stand, as counts (cheap; used on the candidate page instead of loading every row). */
export const GET = withAuth(async (req: NextRequest, { user }) => {
  const candidateId = req.nextUrl.searchParams.get("candidateId") ?? user.candidateId;
  if (!candidateId || !Types.ObjectId.isValid(candidateId) || !canWorkOnCandidate(user, candidateId)) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  await connectDB();
  const rows = await Application.aggregate<{ _id: { automation: string; status: string }; n: number }>([
    { $match: { candidateId: new Types.ObjectId(candidateId) } },
    { $group: { _id: { automation: "$automationStatus", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const sum = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).reduce((total, r) => total + r.n, 0);
  return NextResponse.json({
    needsPreparing: sum((r) => r._id.automation === "QUEUED"),
    ready: sum((r) => r._id.automation === "READY_TO_APPLY"),
    inBrowser: sum((r) => r._id.automation === "APPLY_REQUESTED" || r._id.automation === "IN_PROGRESS"),
    applied: sum((r) => r._id.status === "APPLIED" || r._id.automation === "SUBMITTED"),
  });
}, "applications:read");
