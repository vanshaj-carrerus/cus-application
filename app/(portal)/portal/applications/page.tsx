"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { requestPortalApply } from "@/components/shared/helper-setup";

interface ApplicationRow {
  _id: string;
  status: string;
  automationStatus?: string;
  failureReason?: string;
  appliedAt?: string;
  jobId?: { title: string; company: string; location?: string; source?: string };
  updatedAt: string;
}

const PORTAL_NAMES: Record<string, string> = { LINKEDIN: "LinkedIn", INDEED: "Indeed", GLASSDOOR: "Glassdoor" };
const portalName = (s?: string) => (s ? PORTAL_NAMES[s] ?? s.charAt(0) + s.slice(1).toLowerCase() : null);

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

/** Plain-language progress for the candidate, from where the application is in our team's apply process. */
function progressLabel(a: ApplicationRow): string | null {
  if (a.status !== "TAILORED" && a.status !== "PENDING_MATCHING") return null;
  switch (a.automationStatus) {
    case "QUEUED":
      return "We found this job and are preparing your resume and cover letter";
    case "READY_TO_APPLY":
      return "Your resume and cover letter are ready. Our team will apply shortly";
    case "APPLY_REQUESTED":
    case "IN_PROGRESS":
      return "Our team is submitting your application now";
    default:
      return null;
  }
}

export default function PortalApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Puts an unfinished application at the front of the next run and starts that run in this browser. */
  async function retry(id: string) {
    setRetrying(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/portal/applications/${id}/retry`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not retry");
      const started = await requestPortalApply(data.portal);
      setNotice(started.ok ? "Retrying: a window opened to apply again." : (started.error ?? "Could not start the run."));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not retry");
    } finally {
      setRetrying(null);
    }
  }

  useEffect(() => {
    fetch("/api/portal/applications")
      .then((r) => r.json())
      .then((d) => setApplications(d.applications ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <h1 className="text-xl font-semibold text-slate-900">My Applications</h1>
      {notice && <div className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">{notice}</div>}

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
                    {(a.status === "APPLIED" || portalName(a.jobId?.source)) && (
                      <div className="text-xs text-slate-500">
                        {portalName(a.jobId?.source) && <>via {portalName(a.jobId?.source)}</>}
                        {a.status === "APPLIED" && a.appliedAt && <>{portalName(a.jobId?.source) ? " · " : ""}Applied {new Date(a.appliedAt).toLocaleString()}</>}
                      </div>
                    )}
                    {progressLabel(a) && <div className="text-xs text-blue-700">{progressLabel(a)}</div>}
                    {a.status === "DRAFT" && a.failureReason && <div className={`text-xs ${a.automationStatus === "AWAITING_REVIEW" ? "text-amber-700" : "text-red-700"}`}>{a.automationStatus === "AWAITING_REVIEW" ? "" : "Not finished: "}{a.failureReason.slice(0, 160)}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {a.status === "DRAFT" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retrying === a._id}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void retry(a._id);
                        }}
                      >
                        {retrying === a._id ? "Retrying…" : "Retry"}
                      </Button>
                    )}
                    <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>{a.status.replace(/_/g, " ")}</Badge>
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
