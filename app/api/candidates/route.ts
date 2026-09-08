import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { analyzeCandidate } from "@/lib/services/candidateAnalysisService";

export const GET = withAuth(async (req: NextRequest) => {
  await connectDB();
  const { searchParams } = req.nextUrl;
  const page = Number(searchParams.get("page") ?? "1");
  const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 100);
  const status = searchParams.get("status");
  const q = searchParams.get("q");

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (q) filter.$text = { $search: q };

  const [candidates, total] = await Promise.all([
    Candidate.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Candidate.countDocuments(filter),
  ]);

  return NextResponse.json({ candidates, total, page, limit, pages: Math.ceil(total / limit) });
}, "candidates:read");

export const POST = withAuth(async (req: NextRequest, { user }) => {
  await connectDB();
  const body = await req.json();
  const candidate = await Candidate.create({ ...body, assignedRecruiterId: body.assignedRecruiterId ?? user.sub, source: body.source ?? "MANUAL" });

  // AI candidate intelligence runs automatically on creation — no manual "Analyze" click needed.
  // A transient AI failure must never block candidate creation, so this is best-effort.
  try {
    await analyzeCandidate(String(candidate._id), { userId: user.sub });
  } catch (err) {
    console.error(`Auto-analysis failed for candidate ${candidate._id}:`, err);
  }

  const withProfile = await Candidate.findById(candidate._id);
  return NextResponse.json({ candidate: withProfile }, { status: 201 });
}, "candidates:write");
