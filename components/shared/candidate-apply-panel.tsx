"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FindJobsForm } from "@/components/shared/find-jobs-form";

/** The starting point for applying for one candidate: find jobs, see where their applications stand, open their queue. */
export function CandidateApplyPanel({ candidateId }: { candidateId: string }) {
  const [counts, setCounts] = useState<{ needsPreparing: number; ready: number; inBrowser: number; applied: number } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/applications/counts?candidateId=${candidateId}`);
    const data = await res.json().catch(() => null);
    setCounts(data && !data.error ? data : null);
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  const stats = [
    { label: "Needs preparing", value: counts?.needsPreparing },
    { label: "Ready to apply", value: counts?.ready },
    { label: "In a browser now", value: counts?.inBrowser },
    { label: "Applied", value: counts?.applied },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Job search &amp; applying</CardTitle>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/apply-queue?candidateId=${candidateId}`}>Open this candidate&apos;s apply queue →</Link>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-md border border-slate-200 px-3 py-2">
              <div className="text-xl font-semibold text-slate-900">{s.value ?? "–"}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-slate-900">Find new jobs</div>
          <FindJobsForm candidateId={candidateId} onChanged={() => void load()} />
          <p className="mt-2 text-xs text-slate-500">
            Each job gets a tailored resume and cover letter. Then open the apply queue, click <b>Apply</b>, and finish in your assistant browser.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
