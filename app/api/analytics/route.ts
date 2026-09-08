import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { computeRecruitmentAnalytics } from "@/lib/services/analyticsService";

export const GET = withAuth(async () => {
  const analytics = await computeRecruitmentAnalytics();
  return NextResponse.json(analytics);
}, "analytics:read");
