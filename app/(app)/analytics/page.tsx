"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { Sparkles } from "lucide-react";

interface Analytics {
  metrics: {
    jobsImported: number;
    candidates: number;
    applications: number;
    interviews: number;
    offers: number;
    hires: number;
    matchRate: number;
    interviewRate: number;
    offerRate: number;
    hireRate: number;
  };
  topSkills: { _id: string; count: number }[];
  hardestJobs: { _id: string; title: string; company: string; aiDifficulty: string; aiDifficultyReasoning: string }[];
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [insights, setInsights] = useState<string | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);

  useEffect(() => {
    fetch("/api/analytics")
      .then((r) => r.json())
      .then(setData);
  }, []);

  async function loadInsights() {
    setLoadingInsights(true);
    try {
      const res = await fetch("/api/analytics/ai-insights");
      const d = await res.json();
      setInsights(d.insights ?? null);
    } finally {
      setLoadingInsights(false);
    }
  }

  if (!data) return <Skeleton className="h-96 w-full max-w-5xl" />;

  const metricTiles: [string, number][] = [
    ["Jobs imported", data.metrics.jobsImported],
    ["Candidates", data.metrics.candidates],
    ["Applications", data.metrics.applications],
    ["Interviews", data.metrics.interviews],
    ["Offers", data.metrics.offers],
    ["Hires", data.metrics.hires],
  ];
  const rateTiles: [string, number][] = [
    ["Match rate", data.metrics.matchRate],
    ["Interview rate", data.metrics.interviewRate],
    ["Offer rate", data.metrics.offerRate],
    ["Hire rate", data.metrics.hireRate],
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Analytics</h1>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {metricTiles.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="text-xl font-semibold">{value}</div>
              <div className="text-xs text-slate-500">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {rateTiles.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="text-xl font-semibold">{value}%</div>
              <div className="text-xs text-slate-500">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {!!data.topSkills?.length && (
        <Card>
          <CardHeader>
            <CardTitle>Most In-Demand Skills</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.topSkills} layout="vertical" margin={{ left: 24 }}>
                <XAxis type="number" hide />
                <YAxis dataKey="_id" type="category" width={100} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#0f172a" radius={4} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>AI Insights</CardTitle>
          <Button size="sm" variant="secondary" onClick={loadInsights} disabled={loadingInsights}>
            <Sparkles className={loadingInsights ? "animate-pulse" : ""} />
            {loadingInsights ? "Analyzing…" : "Generate insights"}
          </Button>
        </CardHeader>
        {insights && <CardContent className="whitespace-pre-wrap text-sm text-slate-700">{insights}</CardContent>}
      </Card>
    </div>
  );
}
