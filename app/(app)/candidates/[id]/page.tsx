"use client";

import { useEffect, useState, useCallback, use } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles } from "lucide-react";

interface CandidateDetail {
  _id: string;
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  skills: string[];
  experience: { title: string; company: string; description?: string }[];
  education: { institution: string; degree?: string; field?: string }[];
  status: string;
  aiProfile?: {
    headline?: string;
    overview?: string;
    careerLevel?: string;
    primarySkills?: string[];
    bestFitRoles?: string[];
    strengths?: string[];
    potentialGaps?: string[];
  };
}

export default function CandidateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/candidates/${id}`);
    const data = await res.json();
    setCandidate(data.candidate ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      await fetch(`/api/candidates/${id}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await load();
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) return <Skeleton className="h-96 w-full max-w-4xl" />;
  if (!candidate) return <p className="text-sm text-slate-500">Candidate not found.</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{candidate.name}</h1>
          <p className="text-sm text-slate-500">
            {candidate.email} {candidate.location && `· ${candidate.location}`}
          </p>
        </div>
        <Button onClick={handleAnalyze} disabled={analyzing}>
          <Sparkles className={analyzing ? "animate-pulse" : ""} />
          {analyzing ? "Analyzing…" : candidate.aiProfile ? "Re-analyze with AI" : "Analyze with AI"}
        </Button>
      </div>

      {candidate.aiProfile && (
        <Card>
          <CardHeader>
            <CardTitle>Candidate Intelligence</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <div className="text-base font-medium text-slate-900">{candidate.aiProfile.headline}</div>
              <p className="mt-1 text-sm text-slate-600">{candidate.aiProfile.overview}</p>
            </div>
            {!!candidate.aiProfile.bestFitRoles?.length && (
              <div>
                <div className="text-xs font-medium text-slate-500">Best-fit roles</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {candidate.aiProfile.bestFitRoles.map((r) => (
                    <Badge key={r} variant="info">
                      {r}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {!!candidate.aiProfile.strengths?.length && (
                <div>
                  <div className="text-xs font-medium text-slate-500">Strengths</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-slate-700">
                    {candidate.aiProfile.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!!candidate.aiProfile.potentialGaps?.length && (
                <div>
                  <div className="text-xs font-medium text-slate-500">Potential gaps</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-slate-700">
                    {candidate.aiProfile.potentialGaps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {candidate.skills.map((s) => (
            <Badge key={s} variant="secondary">
              {s}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Experience</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {candidate.experience.map((e, i) => (
            <div key={i}>
              <div className="text-sm font-medium text-slate-900">
                {e.title} · {e.company}
              </div>
              {e.description && <p className="text-xs text-slate-500">{e.description}</p>}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Education</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {candidate.education.map((e, i) => (
            <div key={i} className="text-sm text-slate-700">
              {e.degree} {e.field} — {e.institution}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
