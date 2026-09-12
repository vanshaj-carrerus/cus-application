"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { APPLICATION_STATUSES } from "@/lib/models/enums";

interface ApplicationRow {
  _id: string;
  status: string;
  automationStatus?: string;
  matchScore?: number;
  candidateId?: { _id: string; name: string };
  jobId?: { title: string; company: string };
  updatedAt: string;
}

interface CandidateOption {
  _id: string;
  name: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  PENDING_MATCHING: "secondary",
  DRAFT: "secondary",
  PREPARING: "secondary",
  TAILORED: "info",
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
  SUBMITTED: "info",
  APPLIED: "info",
  SCREENING: "info",
  INTERVIEW: "warning",
  OFFER: "success",
  HIRED: "success",
  REJECTED: "danger",
  WITHDRAWN: "danger",
};

const AUTOMATION_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  NOT_QUEUED: "secondary",
  QUEUED: "secondary",
  IN_PROGRESS: "info",
  AWAITING_REVIEW: "warning",
  SUBMITTED: "success",
  FAILED: "danger",
};

function ApplicationsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const candidateId = searchParams.get("candidateId") ?? "";

  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [candidates, setCandidates] = useState<CandidateOption[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (candidateId) params.set("candidateId", candidateId);
    const res = await fetch(`/api/applications?${params.toString()}`);
    const data = await res.json();
    setApplications(data.applications ?? []);
    setLoading(false);
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial + filter-change data fetch
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/candidates?limit=100")
      .then((r) => r.json())
      .then((d) => setCandidates(d.candidates ?? []));
  }, []);

  function selectCandidate(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("candidateId", value);
    else params.delete("candidateId");
    router.push(`/applications?${params.toString()}`);
  }

  const grouped = APPLICATION_STATUSES.map((status) => ({
    status,
    items: applications.filter((a) => a.status === status),
  })).filter((g) => g.items.length > 0);

  const selectedCandidate = candidates.find((c) => c._id === candidateId);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <h1 className="text-xl font-semibold text-slate-900">Applications</h1>
        <select
          className="h-9 min-w-55 rounded-md border border-slate-200 px-2 text-sm"
          value={candidateId}
          onChange={(e) => selectCandidate(e.target.value)}
        >
          <option value="">All candidates</option>
          {candidates.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {selectedCandidate && (
        <p className="text-sm text-slate-500">
          Showing applications for <span className="font-medium text-slate-700">{selectedCandidate.name}</span> ·{" "}
          <button className="underline" onClick={() => selectCandidate("")}>
            clear filter
          </button>
        </p>
      )}

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : applications.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">
            {candidateId
              ? "No applications yet for this candidate. Run auto-apply ingestion from their profile, or create one manually."
              : "No applications yet. Run auto-apply ingestion from a candidate's profile, or create one from a match."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map((g) => (
            <div key={g.status}>
              <div className="mb-2 flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[g.status] ?? "secondary"}>{g.status.replace(/_/g, " ")}</Badge>
                <span className="text-xs text-slate-400">{g.items.length}</span>
              </div>
              <div className="grid gap-2">
                {g.items.map((a) => (
                  <Link key={a._id} href={`/applications/${a._id}`}>
                    <Card className="hover:shadow-md">
                      <CardContent className="flex items-center justify-between p-3">
                        <div className="text-sm">
                          <span className="font-medium text-slate-900">{a.candidateId?.name ?? "Unknown candidate"}</span>
                          <span className="text-slate-400"> → </span>
                          <span className="text-slate-700">
                            {a.jobId?.title} {a.jobId?.company && `@ ${a.jobId.company}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {a.automationStatus && a.automationStatus !== "NOT_QUEUED" && (
                            <Badge variant={AUTOMATION_VARIANT[a.automationStatus] ?? "secondary"}>{a.automationStatus.replace(/_/g, " ")}</Badge>
                          )}
                          {a.matchScore != null && <Badge variant="info">{a.matchScore}% match</Badge>}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full max-w-6xl" />}>
      <ApplicationsPageInner />
    </Suspense>
  );
}
