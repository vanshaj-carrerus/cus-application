import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { getApplyQueueSummary } from "@/lib/services/applyQueueStats";

/** Apply-queue numbers: everyone gets the queue and their own counts; admins also get every team member and top candidates. */
export const GET = withAuth(async (_req, { user }) => NextResponse.json(await getApplyQueueSummary(user.sub, user.role, user.candidateId)), "applications:read");
