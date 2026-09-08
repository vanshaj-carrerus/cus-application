"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";

interface Option {
  _id: string;
  name?: string;
  title?: string;
  company?: string;
}

interface MatchResult {
  overallScore: number;
  skillMatch: number;
  experienceMatch: number;
  locationMatch: number;
  seniorityMatch: number;
  salaryMatch: number;
  matchingSkills: string[];
  missingSkills: string[];
  strengths: string[];
  concerns: string[];
  recommendation: string;
  explanation: string;
}

export default function MatchingPage() {
  const [candidates, setCandidates] = useState<Option[]>([]);
  const [jobs, setJobs] = useState<Option[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [jobId, setJobId] = useState("");
  const [result, setResult] = useState<MatchResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/candidates?limit=50")
      .then((r) => r.json())
      .then((d) => setCandidates(d.candidates ?? []));
    fetch("/api/jobs?limit=50")
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []));
  }, []);

  async function runMatch() {
    if (!candidateId || !jobId) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/matching", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, jobId }),
      });
      const data = await res.json();
      if (res.ok) setResult(data.match);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">AI Matching</h1>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-slate-600">Candidate</label>
            <select className="w-full rounded-md border border-slate-200 px-2 py-2 text-sm" value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
              <option value="">Select candidate…</option>
              {candidates.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-slate-600">Job</label>
            <select className="w-full rounded-md border border-slate-200 px-2 py-2 text-sm" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Select job…</option>
              {jobs.map((j) => (
                <option key={j._id} value={j._id}>
                  {j.title} @ {j.company}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={runMatch} disabled={loading || !candidateId || !jobId}>
            <Sparkles className={loading ? "animate-pulse" : ""} />
            {loading ? "Matching…" : "Run Match"}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{result.overallScore}% MATCH</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Badge
                variant={
                  result.recommendation === "STRONGLY_RECOMMEND" || result.recommendation === "RECOMMEND"
                    ? "success"
                    : result.recommendation === "REVIEW"
                      ? "warning"
                      : "danger"
                }
              >
                {result.recommendation.replace(/_/g, " ")}
              </Badge>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <ScoreBar label="Skills" value={result.skillMatch} />
                <ScoreBar label="Experience" value={result.experienceMatch} />
                <ScoreBar label="Location" value={result.locationMatch} />
                <ScoreBar label="Seniority" value={result.seniorityMatch} />
                <ScoreBar label="Salary" value={result.salaryMatch} />
              </div>
              <p className="text-sm text-slate-700">{result.explanation}</p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardHeader>
                <CardTitle>Matching Skills</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {result.matchingSkills.map((s) => (
                  <Badge key={s} variant="success">
                    {s}
                  </Badge>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Missing Skills</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {result.missingSkills.map((s) => (
                  <Badge key={s} variant="danger">
                    {s}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value}%</div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100">
        <div className="h-1.5 rounded-full bg-slate-900" style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  );
}
