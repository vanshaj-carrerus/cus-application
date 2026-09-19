"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Search, Trash2 } from "lucide-react";

interface JobRow {
  _id: string;
  title: string;
  company: string;
  location?: string;
  remoteType: string;
  skills: string[];
  aiScore?: number;
  aiDifficulty?: string;
  status: string;
  postedAt?: string;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncQuery, setSyncQuery] = useState("software engineer");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const res = await fetch(`/api/jobs?${params.toString()}`);
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setLoading(false);
  }, [q]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function handleDelete(e: React.MouseEvent, jobId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this job? This also deletes every application submitted against it. This cannot be undone.")) return;
    setDeletingId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (res.ok) {
        setJobs((list) => list.filter((j) => j._id !== jobId));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to delete job");
      }
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await fetch("/api/jobs/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: syncQuery }),
      });
      await load();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <h1 className="text-xl font-semibold text-slate-900">Jobs</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={syncQuery} onChange={(e) => setSyncQuery(e.target.value)} className="w-52" placeholder="e.g. remote react developer" />
          <Button onClick={handleSync} disabled={syncing} variant="secondary">
            <RefreshCw className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing…" : "Sync from Job API"}
          </Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search jobs…" className="pl-8" />
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">
            No jobs yet. Click &ldquo;Sync from Job API&rdquo; to import real listings.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {jobs.map((job) => (
            <Link key={job._id} href={`/jobs/${job._id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-900">{job.title}</div>
                      <div className="text-xs text-slate-500">
                        {job.company} · {job.location || job.remoteType}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {job.aiScore != null && <Badge variant="info">Quality {job.aiScore}</Badge>}
                      {job.aiDifficulty && (
                        <Badge variant={job.aiDifficulty === "EASY" ? "success" : job.aiDifficulty === "MODERATE" ? "warning" : "danger"}>
                          {job.aiDifficulty.replace("_", " ")}
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-slate-400 hover:text-red-600"
                        disabled={deletingId === job._id}
                        onClick={(e) => handleDelete(e, job._id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {job.skills.slice(0, 6).map((s) => (
                      <Badge key={s} variant="secondary">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
