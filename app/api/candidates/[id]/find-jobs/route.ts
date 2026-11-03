import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { Application } from "@/lib/models/Application";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import { findJobsForCandidate } from "@/lib/services/jobIngestionService";
import { prepareApplications } from "@/lib/services/resumeTailorService";

// Searching and tailoring dozens of jobs takes a while; the response streams so the page can show each job as it's ready.
export const runtime = "nodejs";
export const maxDuration = 300;

// What one person may start. Staff searching for a candidate get more room than a candidate searching for themselves.
const MAX_PER_SEARCH = { staff: 100, candidate: 25 };
const CANDIDATE_MAX_NEW_PER_DAY = 100;
const MAX_UNPREPARED = 60;

const running = ((globalThis as unknown as { __runningSearches?: Set<string> }).__runningSearches ??= new Set<string>());

const bodySchema = z.object({
  titles: z.array(z.string().trim().min(1)).min(1).max(5),
  location: z.string().trim().max(120).optional(),
  count: z.number().int().min(1).max(100),
  postedWithin: z.enum(["today", "3days", "week", "month", "all"]),
  remoteOnly: z.boolean().optional(),
});

/**
 * Finds jobs for this candidate and prepares a tailored resume + cover letter for each, all inside this request.
 * The response is newline-delimited JSON events:
 *   {type:"found", created, skippedExisting}   jobs saved, preparation starting
 *   {type:"prepared"|"failed", applicationId, title, company, error?}   one per job as it finishes
 *   {type:"done", prepared, failed}  |  {type:"error", error}
 */
export const POST = withAuth(async (req: NextRequest, { params, user }) => {
  await connectDB();
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give at least one job title, a count (1-100) and how recent the jobs should be" }, { status: 400 });
  if (!canWorkOnCandidate(user, params.id) || !(await Candidate.exists({ _id: params.id }))) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const isCandidate = user.role === "CANDIDATE";
  const maxCount = isCandidate ? MAX_PER_SEARCH.candidate : MAX_PER_SEARCH.staff;
  if (parsed.data.count > maxCount) return NextResponse.json({ error: `You can search for up to ${maxCount} jobs at a time` }, { status: 400 });
  if (running.has(params.id)) return NextResponse.json({ error: "A search for this candidate is already running. Wait for it to finish." }, { status: 409 });

  // Protect the shared server: do not pile more work on a candidate whose earlier jobs are still being prepared.
  const [unprepared, createdToday] = await Promise.all([
    Application.countDocuments({ candidateId: params.id, automationStatus: "QUEUED" }),
    isCandidate ? Application.countDocuments({ candidateId: params.id, createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }) : Promise.resolve(0),
  ]);
  if (unprepared >= MAX_UNPREPARED) return NextResponse.json({ error: `${unprepared} jobs are still waiting to be prepared. Open "Needs preparing" and prepare them first.` }, { status: 429 });
  if (isCandidate && createdToday >= CANDIDATE_MAX_NEW_PER_DAY) return NextResponse.json({ error: "You have reached today's limit for finding new jobs. Try again tomorrow." }, { status: 429 });
  running.add(params.id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          /* the client went away; keep working so the jobs still get prepared */
        }
      };
      try {
        const found = await findJobsForCandidate({ ...parsed.data, candidateId: params.id, requestedBy: user.sub });
        send({ type: "found", created: found.applicationsCreated, skippedExisting: found.skippedExisting, fetched: found.fetched });
        const { prepared, failed } = await prepareApplications(found.applicationIds, (p) =>
          send({ type: p.ok ? "prepared" : "failed", applicationId: p.applicationId, title: p.title, company: p.company, error: p.error })
        );
        send({ type: "done", prepared, failed });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Search failed" });
      } finally {
        running.delete(params.id);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}, "assist:use");
