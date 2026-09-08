"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { APPLICATION_STATUSES } from "@/lib/models/enums";

interface ApplicationRow {
  _id: string;
  status: string;
  matchScore?: number;
  candidateId?: { name: string };
  jobId?: { title: string; company: string };
  updatedAt: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "secondary",
  PREPARING: "secondary",
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

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/applications")
      .then((r) => r.json())
      .then((d) => setApplications(d.applications ?? []))
      .finally(() => setLoading(false));
  }, []);

  const grouped = APPLICATION_STATUSES.map((status) => ({
    status,
    items: applications.filter((a) => a.status === status),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Applications</h1>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : applications.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">
            No applications yet. Create one from a candidate&apos;s match against a job, or via the AI Copilot.
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
                        {a.matchScore != null && <Badge variant="info">{a.matchScore}% match</Badge>}
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
