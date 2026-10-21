import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { computeAutomationStats } from "@/lib/services/automationStats";

// How the auto-apply bot is doing, per site, over the last N days (default 30, max 180).
export const GET = withAuth(async (req: NextRequest) => {
  const requested = Number(req.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), 180) : 30;
  await connectDB();
  return NextResponse.json(await computeAutomationStats(days));
}, "analytics:read");
