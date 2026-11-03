"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Fixed candidate (candidate page). Omit to show a candidate picker (apply queue). */
  candidateId?: string;
  /** Called whenever jobs were added or finished preparing, so the page can refresh its lists. */
  onChanged?: () => void;
  /** Most jobs one search may ask for (a candidate searching for themselves gets fewer than staff). */
  maxCount?: number;
}

interface StreamEvent {
  type: string;
  created?: number;
  skippedExisting?: number;
  error?: string;
}

const INPUT = "h-9 rounded-md border border-slate-200 px-2 text-sm";

/** Marketer-driven job search: titles, place, recency and count. Streams progress while resumes and cover letters are prepared. */
export function FindJobsForm({ candidateId: fixedCandidateId, onChanged, maxCount = 100 }: Props) {
  const [candidates, setCandidates] = useState<Array<{ _id: string; name: string }>>([]);
  const [search, setSearch] = useState({ candidateId: fixedCandidateId ?? "", titles: "", location: "", count: Math.min(25, maxCount), postedWithin: "today" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fixedCandidateId) return;
    fetch("/api/candidates?limit=100")
      .then((r) => r.json())
      .then((d) => setCandidates(d.candidates ?? []))
      .catch(() => undefined);
  }, [fixedCandidateId]);

  async function run() {
    const candidateId = fixedCandidateId ?? search.candidateId;
    const titles = search.titles.split(",").map((t) => t.trim()).filter(Boolean);
    if (!candidateId || titles.length === 0) {
      setMessage("Pick a candidate and enter at least one job title.");
      return;
    }
    setBusy(true);
    setMessage("Searching for jobs…");
    let prepared = 0;
    let failed = 0;
    const summary = () => `Done: ${prepared} job(s) ready to apply${failed ? `, ${failed} need a retry under "Needs preparing"` : ""}.`;
    try {
      const res = await fetch(`/api/candidates/${candidateId}/find-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titles, location: search.location || undefined, count: search.count, postedWithin: search.postedWithin }),
      });
      if (!res.ok || !res.body) {
        setMessage((await res.json().catch(() => ({}))).error ?? "Could not start the search");
        return;
      }
      // One JSON line per event: jobs found, then one per job as its resume + cover letter finish.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as StreamEvent;
          if (ev.type === "found") {
            setMessage(ev.created ? `Found ${ev.created} new job(s)${ev.skippedExisting ? ` (${ev.skippedExisting} already on this candidate's list)` : ""}. Preparing resumes and cover letters…` : "No new jobs found for these filters.");
            onChanged?.();
          } else if (ev.type === "prepared" || ev.type === "failed") {
            if (ev.type === "prepared") prepared++;
            else failed++;
            setMessage(`Prepared ${prepared}${failed ? `, ${failed} failed (retry under "Needs preparing")` : ""}…`);
            onChanged?.();
          } else if (ev.type === "done") setMessage(summary());
          else if (ev.type === "error") setMessage(ev.error ?? "Search failed");
        }
      }
    } catch {
      setMessage('The connection dropped. Anything already prepared is in the queue; check "Needs preparing" for the rest.');
    } finally {
      setBusy(false);
      onChanged?.();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
        {!fixedCandidateId && (
          <select className={`${INPUT} sm:col-span-2`} value={search.candidateId} onChange={(e) => setSearch({ ...search, candidateId: e.target.value })}>
            <option value="">Candidate…</option>
            {candidates.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <input className={`${INPUT} ${fixedCandidateId ? "sm:col-span-3" : "sm:col-span-2"}`} placeholder="Job titles, comma separated" value={search.titles} onChange={(e) => setSearch({ ...search, titles: e.target.value })} />
        <input className={`${INPUT} ${fixedCandidateId ? "sm:col-span-3" : "sm:col-span-2"}`} placeholder="Location (optional)" value={search.location} onChange={(e) => setSearch({ ...search, location: e.target.value })} />
        <select className={`${INPUT} sm:col-span-2`} value={search.postedWithin} onChange={(e) => setSearch({ ...search, postedWithin: e.target.value })}>
          <option value="today">Posted in the last 24 hours</option>
          <option value="3days">Last 3 days</option>
          <option value="week">Last week</option>
          <option value="month">Last month</option>
          <option value="all">Any time</option>
        </select>
        <input type="number" min={1} max={maxCount} className={`${INPUT} sm:col-span-2`} value={search.count} onChange={(e) => setSearch({ ...search, count: Math.max(1, Math.min(maxCount, Number(e.target.value) || 1)) })} />
        <Button className="sm:col-span-2" disabled={busy} onClick={run}>
          {busy ? "Working…" : `Find up to ${search.count} jobs`}
        </Button>
      </div>
      {message && <div className="text-xs text-slate-600">{message}</div>}
    </div>
  );
}
