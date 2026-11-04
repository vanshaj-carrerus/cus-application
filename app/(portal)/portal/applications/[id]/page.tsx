"use client";

import { useEffect, useState, use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface ApplicationDetail {
  _id: string;
  status: string;
  coverLetter?: string;
  applicationProofScreenshot?: string;
  appliedAt?: string;
  confirmationData?: { submittedUrl?: string };
  jobId?: { title: string; company: string; location?: string; source?: string; applicationUrl?: string; sourceUrl?: string };
  resumeVersionId?: { label: string; fileUrl?: string };
  timeline: { status?: string; note?: string; changedAt: string }[];
}

export default function PortalApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/applications/${id}`)
      .then((r) => r.json())
      .then((d) => setApp(d.application ?? null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Skeleton className="h-64 w-full max-w-3xl" />;
  if (!app) return <p className="text-sm text-slate-500">Application not found.</p>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{app.jobId?.title}</h1>
        <p className="text-sm text-slate-500">
          {app.jobId?.company} {app.jobId?.location && `· ${app.jobId.location}`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent>
          <Badge variant="info">{app.status.replace(/_/g, " ")}</Badge>
          <dl className="mt-3 grid gap-1 text-sm text-slate-700">
            {app.jobId?.source && (
              <div>
                <dt className="inline text-slate-500">Portal: </dt>
                <dd className="inline">{app.jobId.source.charAt(0) + app.jobId.source.slice(1).toLowerCase()}</dd>
              </div>
            )}
            {app.appliedAt && (
              <div>
                <dt className="inline text-slate-500">Applied on: </dt>
                <dd className="inline">{new Date(app.appliedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {(app.confirmationData?.submittedUrl || app.jobId?.applicationUrl || app.jobId?.sourceUrl) && (
        <Card>
          <CardHeader>
            <CardTitle>Application page</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {app.confirmationData?.submittedUrl && (
              <div>
                <div className="text-xs text-slate-500">The page the application was submitted on</div>
                <a className="break-all text-blue-700 underline" href={app.confirmationData.submittedUrl} target="_blank" rel="noreferrer">
                  {app.confirmationData.submittedUrl}
                </a>
              </div>
            )}
            {(app.jobId?.applicationUrl || app.jobId?.sourceUrl) && (
              <div>
                <div className="text-xs text-slate-500">The job posting</div>
                <a className="break-all text-blue-700 underline" href={(app.jobId?.applicationUrl || app.jobId?.sourceUrl) as string} target="_blank" rel="noreferrer">
                  {app.jobId?.applicationUrl || app.jobId?.sourceUrl}
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {app.resumeVersionId?.fileUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Your Tailored Resume</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <a href={app.resumeVersionId.fileUrl} target="_blank" rel="noreferrer">
                View PDF
              </a>
            </Button>
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
    </div>
  );
}
