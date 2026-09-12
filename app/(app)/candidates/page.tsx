"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Upload, Plus } from "lucide-react";

interface CandidateRow {
  _id: string;
  name: string;
  location?: string;
  skills: string[];
  yearsOfExperience?: number;
  careerLevel?: string;
  status: string;
}

export default function CandidatesPage() {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const res = await fetch(`/api/candidates?${params.toString()}`);
    const data = await res.json();
    setCandidates(data.candidates ?? []);
    setLoading(false);
  }, [q]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/candidates/upload-resume", { method: "POST", body: formData });
      if (res.ok) await load();
      else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Upload failed");
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <h1 className="text-xl font-semibold text-slate-900">Candidates</h1>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".pdf,.doc,.docx" onChange={handleUpload} className="hidden" id="resume-upload" />
          <Button asChild disabled={uploading} variant="secondary">
            <label htmlFor="resume-upload" className="cursor-pointer">
              <Upload className={uploading ? "animate-pulse" : ""} />
              {uploading ? "Parsing resume…" : "Upload Resume"}
            </label>
          </Button>
          <Button asChild>
            <Link href="/candidates/new">
              <Plus />
              Add Candidate
            </Link>
          </Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search candidates…" className="pl-8" />
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : candidates.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">
            No candidates yet. Upload a resume to add your first candidate.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {candidates.map((c) => (
            <Link key={c._id} href={`/candidates/${c._id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
                  <div>
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-500">
                      {c.location || "Location unknown"} {c.yearsOfExperience != null && `· ${c.yearsOfExperience} yrs`} {c.careerLevel && `· ${c.careerLevel}`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {c.skills.slice(0, 5).map((s) => (
                      <Badge key={s} variant="secondary">
                        {s}
                      </Badge>
                    ))}
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
