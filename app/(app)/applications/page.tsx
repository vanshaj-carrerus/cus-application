"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";
import { APPLICATION_STATUSES } from "@/lib/models/enums";

interface ApplicationRow {
  _id: string;
  status: string;
  automationStatus?: string;
  matchScore?: number;
  candidateId?: { _id: string; name: string };
  jobId?: { title: string; company: string };
  appliedAt?: string;
  updatedAt: string;
}

type SortOption = "updated_desc" | "updated_asc" | "applied_desc" | "candidate_asc" | "job_asc";

const SORT_LABELS: Record<SortOption, string> = {
  updated_desc: "Last activity (newest first)",
  updated_asc: "Last activity (oldest first)",
  applied_desc: "Applied date (newest first)",
  candidate_asc: "Candidate name (A–Z)",
  job_asc: "Job title (A–Z)",
};

function sortApplications(list: ApplicationRow[], sortBy: SortOption): ApplicationRow[] {
  const copy = [...list];
  switch (sortBy) {
    case "updated_desc":
      return copy.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    case "updated_asc":
      return copy.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    case "applied_desc":
      return copy.sort((a, b) => {
        const bTime = b.appliedAt ? new Date(b.appliedAt).getTime() : 0;
        const aTime = a.appliedAt ? new Date(a.appliedAt).getTime() : 0;
        return bTime - aTime;
      });
    case "candidate_asc":
      return copy.sort((a, b) => (a.candidateId?.name ?? "").localeCompare(b.candidateId?.name ?? ""));
    case "job_asc":
      return copy.sort((a, b) => (a.jobId?.title ?? "").localeCompare(b.jobId?.title ?? ""));
  }
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
  const [sortBy, setSortBy] = useState<SortOption>("updated_desc");
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  async function handleDelete(e: React.MouseEvent, applicationId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this application? This cannot be undone.")) return;
    setDeletingId(applicationId);
    try {
      const res = await fetch(`/api/applications/${applicationId}`, { method: "DELETE" });
      if (res.ok) {
        setApplications((list) => list.filter((a) => a._id !== applicationId));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to delete application");
      }
    } finally {
      setDeletingId(null);
    }
  }

  function selectCandidate(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("candidateId", value);
    else params.delete("candidateId");
    router.push(`/applications?${params.toString()}`);
  }

  const sortedApplications = sortApplications(applications, sortBy);
  const grouped = APPLICATION_STATUSES.map((status) => ({
    status,
    items: sortedApplications.filter((a) => a.status === status),
  })).filter((g) => g.items.length > 0);

  const selectedCandidate = candidates.find((c) => c._id === candidateId);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <h1 className="text-xl font-semibold text-slate-900">Applications</h1>
        <div className="flex gap-2">
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
          <select
            className="h-9 min-w-55 rounded-md border border-slate-200 px-2 text-sm"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
          >
            {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
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
                          <div>
                            <span className="font-medium text-slate-900">{a.candidateId?.name ?? "Unknown candidate"}</span>
                            <span className="text-slate-400"> → </span>
                            <span className="text-slate-700">
                              {a.jobId?.title} {a.jobId?.company && `@ ${a.jobId.company}`}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400">
                            {a.appliedAt
                              ? `Applied ${new Date(a.appliedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                              : `Updated ${new Date(a.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {a.automationStatus && a.automationStatus !== "NOT_QUEUED" && (
                            <Badge variant={AUTOMATION_VARIANT[a.automationStatus] ?? "secondary"}>{a.automationStatus.replace(/_/g, " ")}</Badge>
                          )}
                          {a.matchScore != null && <Badge variant="info">{a.matchScore}% match</Badge>}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-400 hover:text-red-600"
                            disabled={deletingId === a._id}
                            onClick={(e) => handleDelete(e, a._id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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
