"use client";

import { useEffect, useState } from "react";
import { PortalsPanel } from "@/components/shared/portals-panel";
import { Skeleton } from "@/components/ui/skeleton";

interface CandidateRow {
  _id: string;
  name: string;
  email?: string;
}

export default function PortalsPage() {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [candidateId, setCandidateId] = useState("");

  useEffect(() => {
    fetch("/api/candidates?limit=100")
      .then((r) => r.json())
      .then((d) => setCandidates(d.candidates ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Portals</h1>
        <p className="text-sm text-slate-500">Connect a candidate&rsquo;s job-portal accounts (LinkedIn, Indeed, Naukri and more).</p>
      </div>

      {loading ? (
        <Skeleton className="h-9 w-72" />
      ) : (
        <select
          className="h-9 w-full max-w-sm rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm"
          value={candidateId}
          onChange={(e) => setCandidateId(e.target.value)}
        >
          <option value="">Select a candidate…</option>
          {candidates.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}
              {c.email ? ` — ${c.email}` : ""}
            </option>
          ))}
        </select>
      )}

      {candidateId ? <PortalsPanel key={candidateId} candidateId={candidateId} /> : !loading && <p className="text-sm text-slate-500">Pick a candidate to manage their portals.</p>}
    </div>
  );
}
