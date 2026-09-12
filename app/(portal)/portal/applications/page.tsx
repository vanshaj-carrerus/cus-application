"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface ApplicationRow {
  _id: string;
  status: string;
  automationStatus?: string;
  jobId?: { title: string; company: string; location?: string };
  updatedAt: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  PENDING_MATCHING: "secondary",
  DRAFT: "secondary",
  PREPARING: "secondary",
  TAILORED: "info",
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
  SUBMITTED: "info",
  APPLIED: "success",
  SCREENING: "info",
  INTERVIEW: "warning",
  OFFER: "success",
  HIRED: "success",
  REJECTED: "danger",
  WITHDRAWN: "danger",
};

export default function PortalApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/portal/applications")
      .then((r) => r.json())
      .then((d) => setApplications(d.applications ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <h1 className="text-xl font-semibold text-slate-900">My Applications</h1>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : applications.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">No applications yet.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {applications.map((a) => (
            <Link key={a._id} href={`/portal/applications/${a._id}`}>
              <Card className="hover:shadow-md">
                <CardContent className="flex items-center justify-between p-3">
                  <div className="text-sm">
                    <div className="font-medium text-slate-900">
                      {a.jobId?.title} {a.jobId?.company && `@ ${a.jobId.company}`}
                    </div>
                    {a.jobId?.location && <div className="text-xs text-slate-500">{a.jobId.location}</div>}
                  </div>
                  <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>{a.status.replace(/_/g, " ")}</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
