import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";

export const GET = withAuth(async (_req: NextRequest, { user }) => {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }

  await connectDB();
  const applications = await Application.find({ candidateId: user.candidateId })
    .populate("jobId", "title company location remoteType")
    .sort({ updatedAt: -1 });
  return NextResponse.json({ applications });
});
