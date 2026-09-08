import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const job = await Job.findById(params.id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}, "jobs:read");
