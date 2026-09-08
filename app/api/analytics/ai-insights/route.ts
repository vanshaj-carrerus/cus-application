import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { computeRecruitmentAnalytics, generateAiInsights } from "@/lib/services/analyticsService";

export const GET = withAuth(async () => {
  const analytics = await computeRecruitmentAnalytics();
  const insights = await generateAiInsights(analytics.metrics, { topSkills: analytics.topSkills, hardestJobs: analytics.hardestJobs });
  return NextResponse.json({ ...analytics, insights });
}, "analytics:read");
