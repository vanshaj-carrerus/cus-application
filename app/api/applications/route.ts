import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";

export const GET = withAuth(async (req: NextRequest, { user }) => {
  await connectDB();
  const { searchParams } = req.nextUrl;
  const filter: Record<string, unknown> = {};
  for (const key of ["candidateId", "jobId", "recruiterId", "clientId", "status"]) {
    const value = searchParams.get(key);
    if (value) filter[key] = value;
  }

  // ?automationStatus=READY_TO_APPLY,IN_PROGRESS  (comma-separated)
  const automationStatus = searchParams.get("automationStatus");
  if (automationStatus) filter.automationStatus = { $in: automationStatus.split(",") };
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 300);

  // A candidate can only ever see their own applications — never trust a client-
  // supplied candidateId for this role, or one candidate could view another's data.
  if (user.role === "CANDIDATE") {
    if (!user.candidateId) return NextResponse.json({ applications: [] });
    filter.candidateId = user.candidateId;
  }

  const applications = await Application.find(filter)
    .select("-timeline -notes -confirmationData")
    .populate("candidateId", "name email")
    .populate("jobId", "title company location applicationUrl")
    .populate("resumeVersionId", "fileUrl")
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  return NextResponse.json({ applications });
}, "applications:read");

export const POST = withAuth(async (req: NextRequest, { user }) => {
  await connectDB();
  const body = await req.json();
  const application = await Application.create({
    ...body,
    recruiterId: body.recruiterId ?? user.sub,
    status: body.status ?? "DRAFT",
    timeline: [{ status: body.status ?? "DRAFT", changedBy: user.sub, changedAt: new Date() }],
  });
  return NextResponse.json({ application }, { status: 201 });
}, "applications:write");
