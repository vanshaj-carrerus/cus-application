"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FindJobsForm } from "@/components/shared/find-jobs-form";
import { HelperSetup, pingExtension, requestApply } from "@/components/shared/helper-setup";
import { CheckCircle2, ClipboardCopy, ExternalLink, FileText, Loader2, MousePointerClick } from "lucide-react";

interface QueueRow {
  _id: string;
  automationStatus: string;
  matchScore?: number;
  coverLetter?: string;
  candidateId?: { _id: string; name: string };
  jobId?: { title: string; company: string; location?: string; applicationUrl?: string };
  resumeVersionId?: { fileUrl?: string };
  failureReason?: string;
  appliedAt?: string;
  applicationProofScreenshot?: string;
  updatedAt: string;
}

type Tab = "READY_TO_APPLY" | "WORKING" | "APPLIED" | "PREPARING";

const TABS: Array<{ id: Tab; label: string; statuses: string[] }> = [
  { id: "READY_TO_APPLY", label: "Ready to apply", statuses: ["READY_TO_APPLY"] },
  { id: "WORKING", label: "In your browser", statuses: ["APPLY_REQUESTED", "IN_PROGRESS"] },
  { id: "APPLIED", label: "Applied", statuses: ["SUBMITTED"] },
  { id: "PREPARING", label: "Needs preparing", statuses: ["QUEUED"] },
];

/**
 * The apply queue. Staff see every candidate's jobs; a candidate login (`fixedCandidateId`) sees only their own, finds
 * jobs for themselves and applies through the same extension.
 */
export function ApplyQueueView({ fixedCandidateId }: { fixedCandidateId?: string }) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("READY_TO_APPLY");
  const [candidateId, setCandidateId] = useState(fixedCandidateId ?? "");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ queue: { ready: number; inBrowser: number }; me: { today: number; week: number } } | null>(null);
  const load = useCallback(async () => {
    // Applied jobs are fetched on their own (most recent 100) so a long history never crowds out the active ones.
    const get = (statuses: string, limit: number) =>
      fetch(`/api/applications?automationStatus=${statuses}&limit=${limit}`)
        .then((r) => r.json())
        .then((d) => (d.applications ?? []) as QueueRow[])
        .catch(() => [] as QueueRow[]);
    const [active, applied] = await Promise.all([get("QUEUED,READY_TO_APPLY,APPLY_REQUESTED,IN_PROGRESS", 300), get("SUBMITTED", 100)]);
    setRows([...active, ...applied]);
    setLoading(false);
  }, []);

  const loadSummary = useCallback(() => {
    fetch("/api/analytics/marketing")
      .then((r) => r.json())
      .then((d) => d.queue && setSummary(d))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (fixedCandidateId) return;
    const fromUrl = new URLSearchParams(window.location.search).get("candidateId");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the ?candidateId= filter once after mount
    if (fromUrl) setCandidateId(fromUrl);
  }, [fixedCandidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch, then keep the queue fresh while it is open
    load();
    loadSummary();
    // Refresh every 10s while this tab is visible; a hidden tab doesn't poll (hundreds of open queues add up).
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadSummary]);

  const candidates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.candidateId) seen.set(r.candidateId._id, r.candidateId.name);
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const inTab = (r: QueueRow, t: Tab) => TABS.find((x) => x.id === t)!.statuses.includes(r.automationStatus) && (!candidateId || r.candidateId?._id === candidateId);
  const counts = Object.fromEntries(TABS.map((t) => [t.id, rows.filter((r) => inTab(r, t.id)).length])) as Record<Tab, number>;
  const visible = rows.filter((r) => inTab(r, tab));

  async function call(id: string, url: string, init: RequestInit) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Something went wrong");
      await load();
    } finally {
      setBusyId(null);
    }
  }
  // Apply: make sure the extension is ready, mark the job as this person's, then ask the extension to open it.
  async function apply(id: string) {
    setError(null);
    const ext = await pingExtension();
    if (!ext.installed || !ext.paired) {
      setError(ext.installed ? "Connect the extension first (step 3 below), then click Apply again." : "Install the extension first (steps below), then click Apply again.");
      document.getElementById("helper-setup")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/applications/${id}/assist`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "Could not start this application");
        return;
      }
      const opened = await requestApply(id);
      if (!opened.ok) {
        // Nothing opened, so don't leave it marked as in progress.
        await fetch(`/api/applications/${id}/assist`, { method: "DELETE" }).catch(() => undefined);
        setError(opened.error ?? "Could not open the application");
      }
    } finally {
      setBusyId(null);
      await load();
      loadSummary();
    }
  }
  const reopen = async (id: string) => {
    const opened = await requestApply(id);
    if (!opened.ok) setError(opened.error ?? "Could not open the application");
  };
  const prepare = (id: string) => call(id, `/api/applications/${id}/prepare`, { method: "POST" });
  const cancel = (id: string) => call(id, `/api/applications/${id}/assist`, { method: "DELETE" });
  const outcome = (id: string, value: "APPLIED" | "RESET") => call(id, `/api/applications/${id}/outcome`, { method: "POST", body: JSON.stringify({ outcome: value }) });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Apply queue</h1>
          <p className="mt-1 text-sm text-slate-600">
            Resume and cover letter are ready for each job. Click <b>Apply</b>: the job opens in a new tab of your browser, you sign in and click through, and the extension fills in the forms. You press Submit.
          </p>
        </div>
        {!fixedCandidateId && (
        <select className="h-9 min-w-55 rounded-md border border-slate-200 px-2 text-sm" value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
          <option value="">All candidates</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        )}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <div className="text-sm font-medium text-slate-900">{fixedCandidateId ? "Find jobs for me" : "Find jobs for a candidate"}</div>
          <FindJobsForm candidateId={fixedCandidateId} maxCount={fixedCandidateId ? 25 : 100} onChanged={() => { void load(); loadSummary(); }} />
        </CardContent>
      </Card>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={fixedCandidateId ? "Applied today" : "You applied today"} value={summary.me.today} />
          <Stat label={fixedCandidateId ? "Applied, last 7 days" : "You, last 7 days"} value={summary.me.week} />
          <Stat label={fixedCandidateId ? "Ready to apply" : "Ready to apply (team)"} value={summary.queue.ready} />
          <Stat label={fixedCandidateId ? "Open in a browser" : "Open in a browser (team)"} value={summary.queue.inBrowser} />
        </div>
      )}

      <HelperSetup />

      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {t.label} <span className="ml-1 rounded-full bg-slate-100 px-1.5 text-xs">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-slate-500">
            {tab === "READY_TO_APPLY" ? "Nothing ready right now. New jobs show up here once their resume and cover letter are generated." : "Nothing here."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((r) => (
            <Card key={r._id}>
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/applications/${r._id}`} className="truncate font-medium text-slate-900 hover:underline">
                      {r.jobId?.title ?? "Job"} <span className="font-normal text-slate-500">@ {r.jobId?.company}</span>
                    </Link>
                    {typeof r.matchScore === "number" && <Badge variant="info">{Math.round(r.matchScore)}% match</Badge>}
                  </div>
                  <div className="mt-0.5 text-sm text-slate-600">
                    {!fixedCandidateId && (
                      <>
                        for <b>{r.candidateId?.name ?? "candidate"}</b>
                      </>
                    )}
                    {r.jobId?.location ? ` · ${r.jobId.location}` : ""}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                    {r.resumeVersionId?.fileUrl && (
                      <a href={r.resumeVersionId.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-slate-900">
                        <FileText className="size-3.5" /> Tailored resume
                      </a>
                    )}
                    {r.coverLetter && (
                      <button onClick={() => navigator.clipboard.writeText(r.coverLetter!)} className="inline-flex items-center gap-1 hover:text-slate-900">
                        <ClipboardCopy className="size-3.5" /> Copy cover letter
                      </button>
                    )}
                    {r.jobId?.applicationUrl && (
                      <a href={r.jobId.applicationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-slate-900">
                        <ExternalLink className="size-3.5" /> Job posting
                      </a>
                    )}
                  </div>
                  {r.failureReason && (r.automationStatus === "READY_TO_APPLY" || r.automationStatus === "QUEUED") && <div className="mt-1 text-xs text-amber-700">Last try: {r.failureReason}</div>}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {r.automationStatus === "READY_TO_APPLY" && (
                    <>
                      <Button variant="ghost" size="sm" disabled={busyId === r._id} onClick={() => confirm("Mark this as already applied?") && outcome(r._id, "APPLIED")}>
                        Mark applied
                      </Button>
                      <Button disabled={busyId === r._id} onClick={() => apply(r._id)}>
                        {busyId === r._id ? <Loader2 className="animate-spin" /> : <MousePointerClick />}
                        {busyId === r._id ? "Opening…" : "Apply"}
                      </Button>
                    </>
                  )}
                  {r.automationStatus === "APPLY_REQUESTED" && (
                    <>
                      <Loader2 className="size-4 animate-spin text-slate-500" />
                      <span className="max-w-56 text-xs text-slate-500">
                        Opening a tab… If nothing opened, <a href="#helper-setup" className="underline">check the extension</a>, or
                      </span>
                      <Button variant="outline" size="sm" onClick={() => reopen(r._id)}>
                        Open again
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busyId === r._id} onClick={() => cancel(r._id)}>
                        Cancel
                      </Button>
                    </>
                  )}
                  {r.automationStatus === "IN_PROGRESS" && (
                    <>
                      <Badge variant="info" className="gap-1">
                        <Loader2 className="size-3 animate-spin" /> Application in progress
                      </Badge>
                      <Button variant="outline" size="sm" disabled={busyId === r._id} onClick={() => outcome(r._id, "APPLIED")}>
                        I submitted it
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busyId === r._id} onClick={() => outcome(r._id, "RESET")}>
                        Put back
                      </Button>
                    </>
                  )}
                  {r.automationStatus === "SUBMITTED" && (
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2 className="size-3" /> Applied{r.appliedAt ? ` ${new Date(r.appliedAt).toLocaleDateString()}` : ""}
                      </Badge>
                      {r.applicationProofScreenshot && (
                        <a href={r.applicationProofScreenshot} target="_blank" rel="noreferrer" className="text-xs text-slate-500 underline">
                          View proof
                        </a>
                      )}
                    </div>
                  )}
                  {r.automationStatus === "QUEUED" && (
                    <Button variant="outline" size="sm" disabled={busyId === r._id} onClick={() => prepare(r._id)}>
                      {busyId === r._id ? (
                        <>
                          <Loader2 className="animate-spin" /> Preparing…
                        </>
                      ) : (
                        "Prepare now"
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xl font-semibold text-slate-900">{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </CardContent>
    </Card>
  );
}
