"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface ResumeRow {
  _id: string;
  label: string;
  isTailored: boolean;
  aiQuality?: { score?: number };
  candidateId?: { name: string };
  jobId?: { title: string; company: string };
  createdAt: string;
}

export default function ResumesPage() {
  const [resumes, setResumes] = useState<ResumeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/resumes")
      .then((r) => r.json())
      .then((d) => setResumes(d.resumes ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Resumes</h1>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : resumes.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">
            No resume versions yet. Tailor a resume from a candidate&apos;s AI Copilot conversation or the resume-tailor API.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {resumes.map((r) => (
            <Card key={r._id}>
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">{r.label}</div>
                  <div className="text-xs text-slate-500">
                    {r.candidateId?.name} {r.jobId && `→ ${r.jobId.title} @ ${r.jobId.company}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.isTailored && <Badge variant="info">Tailored</Badge>}
                  {r.aiQuality?.score != null && <Badge variant="secondary">Quality {r.aiQuality.score}</Badge>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
