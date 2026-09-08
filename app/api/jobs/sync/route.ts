import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { syncJobs } from "@/lib/services/jobSyncService";

export const POST = withAuth(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { query?: string; page?: number; numPages?: number };
  const query = body.query || "software developer";
  const result = await syncJobs(query, { page: body.page, numPages: body.numPages });
  return NextResponse.json(result);
}, "jobs:sync");
