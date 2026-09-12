import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";

// Fields a candidate may edit on their own profile. Deliberately excludes anything
// recruiter/pipeline-owned: status, assignedRecruiterId, aiProfile, resumeFiles, etc.
const EDITABLE_FIELDS = ["phone", "location", "expectedSalary", "currency", "noticePeriod", "preferredRoles", "preferredLocations"] as const;

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

export const GET = withAuth(async (_req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  await connectDB();
  const candidate = await Candidate.findById(user.candidateId);
  if (!candidate) return NextResponse.json({ error: "Candidate profile not found" }, { status: 404 });
  return NextResponse.json({ candidate });
});

export const PATCH = withAuth(async (req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  await connectDB();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) update[field] = body[field];
  }

  const candidate = await Candidate.findByIdAndUpdate(user.candidateId, { $set: update }, { new: true });
  if (!candidate) return NextResponse.json({ error: "Candidate profile not found" }, { status: 404 });
  return NextResponse.json({ candidate });
});
