import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";

export const GET = withAuth(async (_req: NextRequest, { params, user }) => {
  await connectDB();

  if (user.role === "CANDIDATE") {
    const application = await Application.findById(params.id).select("candidateId");
    if (!application || String(application.candidateId) !== user.candidateId) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }
  }

  const attempts = await ApplicationAttempt.find({ applicationId: params.id }).sort({ attemptNumber: -1 });
  return NextResponse.json({ attempts });
}, "applications:read");
