import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const candidate = await Candidate.findById(params.id);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  return NextResponse.json({ candidate });
}, "candidates:read");

export const PATCH = withAuth(async (req: NextRequest, { params }) => {
  await connectDB();
  const body = await req.json();
  const candidate = await Candidate.findByIdAndUpdate(params.id, { $set: body }, { new: true });
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  return NextResponse.json({ candidate });
}, "candidates:write");
