"use client";

import { useEffect, useState, useCallback, use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { APPLICATION_STATUSES } from "@/lib/models/enums";

interface ApplicationDetail {
  _id: string;
  status: string;
  matchScore?: number;
  coverLetter?: string;
  candidateId?: { _id: string; name: string; email?: string };
  jobId?: { _id: string; title: string; company: string };
  timeline: { status: string; note?: string; changedAt: string }[];
  notes: { text: string; createdAt: string }[];
}

export default function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/applications/${id}`);
    const data = await res.json();
    setApp(data.application ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function updateStatus(status: string) {
    setUpdating(true);
    try {
      await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await load();
    } finally {
      setUpdating(false);
    }
  }

  if (loading) return <Skeleton className="h-96 w-full max-w-3xl" />;
  if (!app) return <p className="text-sm text-slate-500">Application not found.</p>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          {app.candidateId?.name} → {app.jobId?.title}
        </h1>
        <p className="text-sm text-slate-500">{app.jobId?.company}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Badge variant="info">{app.status.replace(/_/g, " ")}</Badge>
          <select
            className="rounded-md border border-slate-200 px-2 py-1 text-xs"
            disabled={updating}
            value=""
            onChange={(e) => e.target.value && updateStatus(e.target.value)}
          >
            <option value="">Change status…</option>
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {app.coverLetter && (
        <Card>
          <CardHeader>
            <CardTitle>Cover Letter</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm text-slate-700">{app.coverLetter}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {app.timeline?.map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-slate-700">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
              <span className="font-medium">{t.status.replace(/_/g, " ")}</span>
              <span className="text-xs text-slate-400">{new Date(t.changedAt).toLocaleString()}</span>
              {t.note && <span className="text-xs text-slate-500">— {t.note}</span>}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button variant="outline" asChild>
          <a href={`/candidates/${app.candidateId?._id}`}>View Candidate</a>
        </Button>
        <Button variant="outline" asChild>
          <a href={`/jobs/${app.jobId?._id}`}>View Job</a>
        </Button>
      </div>
    </div>
  );
}
