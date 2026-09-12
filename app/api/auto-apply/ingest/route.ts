import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { jobIngestionQueue } from "@/lib/queue/queues";

export const POST = withAuth(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { profileId?: string };
  if (!body.profileId) {
    return NextResponse.json({ error: "profileId is required" }, { status: 400 });
  }
  const job = await jobIngestionQueue().add("ingest", { profileId: body.profileId });
  return NextResponse.json({ queued: true, jobId: job.id });
}, "autoapply:manage");
