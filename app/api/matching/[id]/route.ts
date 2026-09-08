import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { JobMatch } from "@/lib/models/JobMatch";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const match = await JobMatch.findById(params.id);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  return NextResponse.json({ match });
}, "matching:read");
