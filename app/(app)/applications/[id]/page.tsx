"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";
import { APPLICATION_STATUSES } from "@/lib/models/enums";

interface ApplicationDetail {
  _id: string;
  status: string;
  automationStatus?: string;
  failureReason?: string;
  applicationProofScreenshot?: string;
  matchScore?: number;
  coverLetter?: string;
  candidateId?: { _id: string; name: string; email?: string };
  jobId?: { _id: string; title: string; company: string; applicationUrl?: string };
  resumeVersionId?: { _id: string; label: string; fileUrl?: string; isTailored?: boolean };
  timeline: { status?: string; note?: string; changedAt: string }[];
  notes: { text: string; createdAt: string }[];
}

interface AttemptStep {
  step: string;
  status: string;
  message?: string;
  screenshotUrl?: string;
  timestamp: string;
}

interface Attempt {
  _id: string;
  board: string;
  attemptNumber: number;
  status: string;
  errorMessage?: string;
  steps: AttemptStep[];
  startedAt: string;
  finishedAt?: string;
}

const AUTOMATION_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  NOT_QUEUED: "secondary",
  QUEUED: "secondary",
  IN_PROGRESS: "info",
  AWAITING_REVIEW: "warning",
  SUBMITTED: "success",
  FAILED: "danger",
};

const ATTEMPT_STEP_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  STARTED: "info",
  SUCCESS: "success",
  FAILED: "danger",
  SKIPPED: "secondary",
};

const ATTEMPT_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info"> = {
  PENDING: "secondary",
  RUNNING: "info",
  SUCCESS: "success",
  FAILED: "danger",
  NEEDS_REVIEW: "warning",
  BLOCKED_CAPTCHA: "warning",
  BLOCKED_LOGIN_REQUIRED: "warning",
  BLOCKED_OTP_REQUIRED: "warning",
};

export default function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [appRes, attemptsRes] = await Promise.all([fetch(`/api/applications/${id}`), fetch(`/api/applications/${id}/attempts`)]);
    const appData = await appRes.json();
    const attemptsData = await attemptsRes.json();
    setApp(appData.application ?? null);
    setAttempts(attemptsData.attempts ?? []);
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

  async function handleDelete() {
    if (!confirm("Delete this application? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/applications/${id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/applications");
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to delete application");
      }
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <Skeleton className="h-96 w-full max-w-3xl" />;
  if (!app) return <p className="text-sm text-slate-500">Application not found.</p>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {app.candidateId?._id ? (
              <Link href={`/candidates/${app.candidateId._id}`} className="hover:underline">
                {app.candidateId.name}
              </Link>
            ) : (
              app.candidateId?.name
            )}{" "}
            → {app.jobId?.title}
          </h1>
          <p className="text-sm text-slate-500">{app.jobId?.company}</p>
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
          <Trash2 />
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Badge variant="info">{app.status.replace(/_/g, " ")}</Badge>
          {app.automationStatus && app.automationStatus !== "NOT_QUEUED" && (
            <Badge variant={AUTOMATION_VARIANT[app.automationStatus] ?? "secondary"}>Automation: {app.automationStatus.replace(/_/g, " ")}</Badge>
          )}
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

      {app.failureReason && (
        <Card className="border-red-200 bg-red-50">
          <CardHeader>
            <CardTitle className="text-red-700">Automation Failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-red-700">{app.failureReason}</CardContent>
        </Card>
      )}

      {(app.resumeVersionId?.fileUrl || app.applicationProofScreenshot) && (
        <Card>
          <CardHeader>
            <CardTitle>Auto-Apply Artifacts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {app.resumeVersionId?.fileUrl && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-700">Tailored resume ({app.resumeVersionId.label})</span>
                <Button variant="outline" size="sm" asChild>
                  <a href={app.resumeVersionId.fileUrl} target="_blank" rel="noreferrer">
                    View PDF
                  </a>
                </Button>
              </div>
            )}
            {app.applicationProofScreenshot && (
              <div>
                <div className="mb-1 text-sm text-slate-700">Submission proof screenshot</div>
                <a href={app.applicationProofScreenshot} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not an optimizable static asset */}
                  <img src={app.applicationProofScreenshot} alt="Application submission proof" className="max-h-64 rounded-md border border-slate-200" />
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {app.coverLetter && (
        <Card>
          <CardHeader>
            <CardTitle>Cover Letter</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm text-slate-700">{app.coverLetter}</CardContent>
        </Card>
      )}

      {attempts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Automation Attempts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {attempts.map((attempt) => (
              <div key={attempt._id} className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant={ATTEMPT_STATUS_VARIANT[attempt.status] ?? "secondary"}>{attempt.status.replace(/_/g, " ")}</Badge>
                  <span className="text-xs text-slate-500">
                    Attempt #{attempt.attemptNumber} · {attempt.board} · {new Date(attempt.startedAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {attempt.steps.map((step, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-slate-600">
                      <Badge variant={ATTEMPT_STEP_VARIANT[step.status] ?? "secondary"} className="shrink-0">
                        {step.step}
                      </Badge>
                      <span>{step.message}</span>
                      {step.screenshotUrl && (
                        <a href={step.screenshotUrl} target="_blank" rel="noreferrer" className="underline">
                          screenshot
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
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
              {t.status && <span className="font-medium">{t.status.replace(/_/g, " ")}</span>}
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
