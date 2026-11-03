import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { ingestJobsForProfile } from "@/lib/services/jobIngestionService";
import { prepareApplications } from "@/lib/services/resumeTailorService";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Runs a candidate's saved auto-apply profile now: fetch jobs, then prepare a resume + cover letter for each. */
export const POST = withAuth(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { profileId?: string };
  if (!body.profileId) {
    return NextResponse.json({ error: "profileId is required" }, { status: 400 });
  }
  const ingest = await ingestJobsForProfile(body.profileId);
  const { prepared, failed } = await prepareApplications(ingest.applicationIds);
  return NextResponse.json({ ...ingest, prepared, failed });
}, "autoapply:manage");
