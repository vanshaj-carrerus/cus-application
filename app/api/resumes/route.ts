import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Resume } from "@/lib/models/Resume";

export const GET = withAuth(async (req: NextRequest) => {
  await connectDB();
  const candidateId = req.nextUrl.searchParams.get("candidateId");
  const filter = candidateId ? { candidateId } : {};
  const resumes = await Resume.find(filter).populate("candidateId", "name").populate("jobId", "title company").sort({ createdAt: -1 }).limit(100);
  return NextResponse.json({ resumes });
}, "resumes:read");
