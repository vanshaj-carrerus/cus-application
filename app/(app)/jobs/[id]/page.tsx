"use client";

import { useEffect, useState, useCallback, use } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles } from "lucide-react";

interface JobDetail {
  _id: string;
  title: string;
  company: string;
  location?: string;
  remoteType: string;
  description: string;
  skills: string[];
  status: string;
  aiScore?: number;
  aiDifficulty?: string;
  aiDifficultyReasoning?: string;
  aiAnalysis?: {
    summary?: string;
    mustHaveSkills?: string[];
    niceToHaveSkills?: string[];
    hiddenRequirements?: { text: string }[];
    screeningQuestions?: string[];
    searchKeywords?: string[];
    qualityScore?: number;
    qualityBreakdown?: Record<string, number>;
    qualityIssues?: string[];
  };
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/jobs/${id}`);
    const data = await res.json();
    setJob(data.job ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      await fetch(`/api/jobs/${id}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await load();
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) return <Skeleton className="h-96 w-full max-w-4xl" />;
  if (!job) return <p className="text-sm text-slate-500">Job not found.</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{job.title}</h1>
          <p className="text-sm text-slate-500">
            {job.company} · {job.location || job.remoteType}
          </p>
        </div>
        <Button onClick={handleAnalyze} disabled={analyzing}>
          <Sparkles className={analyzing ? "animate-pulse" : ""} />
          {analyzing ? "Analyzing…" : job.aiAnalysis ? "Re-analyze with AI" : "Analyze with AI"}
        </Button>
      </div>

      {job.aiAnalysis?.summary && (
        <Card>
          <CardHeader>
            <CardTitle>AI Job Summary</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-slate-700">{job.aiAnalysis.summary}</CardContent>
        </Card>
      )}

      {(job.aiScore != null || job.aiDifficulty) && (
        <div className="grid grid-cols-2 gap-3">
          {job.aiScore != null && (
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-slate-500">Job Quality</div>
                <div className="text-2xl font-semibold">{job.aiScore} / 100</div>
                {job.aiAnalysis?.qualityIssues?.map((issue, i) => (
                  <p key={i} className="mt-1 text-xs text-amber-700">
                    {issue}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
          {job.aiDifficulty && (
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-slate-500">Fill Difficulty (estimate)</div>
                <Badge variant={job.aiDifficulty === "EASY" ? "success" : job.aiDifficulty === "MODERATE" ? "warning" : "danger"} className="mt-1">
                  {job.aiDifficulty.replace("_", " ")}
                </Badge>
                <p className="mt-1 text-xs text-slate-500">{job.aiDifficultyReasoning}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {job.aiAnalysis && (
        <div className="grid grid-cols-2 gap-3">
          <SkillList title="Must-Have Skills" items={job.aiAnalysis.mustHaveSkills} />
          <SkillList title="Nice-to-Have Skills" items={job.aiAnalysis.niceToHaveSkills} />
        </div>
      )}

      {!!job.aiAnalysis?.hiddenRequirements?.length && (
        <Card>
          <CardHeader>
            <CardTitle>Hidden Requirements (inferred)</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-sm text-slate-700">
              {job.aiAnalysis.hiddenRequirements.map((h, i) => (
                <li key={i}>{h.text}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {!!job.aiAnalysis?.screeningQuestions?.length && (
        <Card>
          <CardHeader>
            <CardTitle>Screening Questions</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-1 pl-4 text-sm text-slate-700">
              {job.aiAnalysis.screeningQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Description</CardTitle>
        </CardHeader>
        <CardContent className="whitespace-pre-wrap text-sm text-slate-700">{job.description}</CardContent>
      </Card>
    </div>
  );
}

function SkillList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <Badge key={s} variant="secondary">
            {s}
          </Badge>
        ))}
      </CardContent>
    </Card>
  );
}
