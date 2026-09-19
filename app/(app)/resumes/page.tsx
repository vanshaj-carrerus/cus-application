"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";

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
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/resumes");
    const data = await res.json();
    setResumes(data.resumes ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function handleDelete(resumeId: string) {
    if (!confirm("Delete this resume version? This cannot be undone.")) return;
    setDeletingId(resumeId);
    try {
      const res = await fetch(`/api/resumes/${resumeId}`, { method: "DELETE" });
      if (res.ok) {
        setResumes((list) => list.filter((r) => r._id !== resumeId));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to delete resume");
      }
    } finally {
      setDeletingId(null);
    }
  }

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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-slate-400 hover:text-red-600"
                    disabled={deletingId === r._id}
                    onClick={() => handleDelete(r._id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
