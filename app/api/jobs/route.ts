import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";

export const GET = withAuth(async (req: NextRequest) => {
  await connectDB();
  const { searchParams } = req.nextUrl;
  const page = Number(searchParams.get("page") ?? "1");
  const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 100);
  const status = searchParams.get("status");
  const remoteType = searchParams.get("remoteType");
  const q = searchParams.get("q");

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (remoteType) filter.remoteType = remoteType;
  if (q) filter.$text = { $search: q };

  const [jobs, total] = await Promise.all([
    Job.find(filter)
      .sort({ postedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Job.countDocuments(filter),
  ]);

  return NextResponse.json({ jobs, total, page, limit, pages: Math.ceil(total / limit) });
}, "jobs:read");
