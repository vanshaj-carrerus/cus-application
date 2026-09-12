"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface CandidateProfile {
  name: string;
  aiProfile?: { headline?: string };
}

interface ApplicationSummary {
  status: string;
}

export default function PortalOverviewPage() {
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [applications, setApplications] = useState<ApplicationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetch("/api/portal/me").then((r) => r.json()), fetch("/api/portal/applications").then((r) => r.json())])
      .then(([meData, appsData]) => {
        setCandidate(meData.candidate ?? null);
        setApplications(appsData.applications ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-64 w-full max-w-3xl" />;

  const counts = applications.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Welcome, {candidate?.name}</h1>
        {candidate?.aiProfile?.headline && <p className="text-sm text-slate-500">{candidate.aiProfile.headline}</p>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your Applications</CardTitle>
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <p className="text-sm text-slate-500">No applications yet — your recruiter will enroll you into auto-apply, or you can check back soon.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(counts).map(([status, count]) => (
                <Badge key={status} variant="info">
                  {status.replace(/_/g, " ")}: {count}
                </Badge>
              ))}
            </div>
          )}
          <Link href="/portal/applications" className="mt-3 inline-block text-sm text-slate-700 underline">
            View all applications →
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Link href="/portal/profile" className="text-slate-700 underline">
            Update your profile & preferences
          </Link>
          <Link href="/portal/credentials" className="text-slate-700 underline">
            Manage job board logins (for auto-apply)
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
