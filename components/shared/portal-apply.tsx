"use client";

import { useState } from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requestPortalApply } from "@/components/shared/helper-setup";

export interface ApplyRunView {
  state: "RUNNING" | "PAUSED" | "STOPPING" | "DONE" | "STOPPED" | "FAILED";
  message?: string;
  startedAt: string;
  finishedAt?: string;
  /** Runs (browser windows) working right now. */
  activeRuns?: number;
  applied: number;
  skipped: number;
  failed: number;
  log: Array<{ at: string; title: string; company?: string; outcome: string; reason?: string }>;
}

const STATE_BADGE: Record<ApplyRunView["state"], { label: string; variant: "info" | "warning" | "success" | "secondary" | "danger" }> = {
  RUNNING: { label: "Running", variant: "info" },
  PAUSED: { label: "Needs you", variant: "warning" },
  STOPPING: { label: "Stopping…", variant: "warning" },
  DONE: { label: "Finished", variant: "success" },
  STOPPED: { label: "Stopped", variant: "secondary" },
  FAILED: { label: "Failed", variant: "danger" },
};

const OUTCOME_VARIANT: Record<string, "success" | "secondary" | "danger"> = { APPLIED: "success", SKIPPED: "secondary", FAILED: "danger" };

/** The Start button for a portal and what the run is doing. The run itself happens in the candidate's browser, through the extension. */
export function PortalApplyCard({ portal, name, candidateId, apply, extReady, reload }: { portal: string; name: string; candidateId?: string; apply: ApplyRunView | null; extReady: boolean; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = apply?.state === "RUNNING" || apply?.state === "PAUSED" || apply?.state === "STOPPING";

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await requestPortalApply(portal, candidateId);
      if (!r.ok) setError(r.error ?? "Could not start");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await fetch("/api/portals/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidateId, portal, action: "stop" }) });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-900">{name} auto-apply</div>
          {apply && <Badge variant={STATE_BADGE[apply.state].variant}>{STATE_BADGE[apply.state].label}</Badge>}
          {active && (apply?.activeRuns ?? 0) > 1 && <Badge variant="info">{apply?.activeRuns} runs</Badge>}
          <div className="ml-auto flex gap-2">
            {active && (
              <Button size="sm" variant="outline" onClick={stop} disabled={busy || apply?.state === "STOPPING"}>
                <Square className="mr-1 h-3.5 w-3.5" />
                Stop
              </Button>
            )}
            <Button size="sm" onClick={start} disabled={busy || !extReady}>
              <Play className="mr-1 h-3.5 w-3.5" />
              {active ? "Start another run" : "Start"}
            </Button>
          </div>
        </div>
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">How it works</summary>
          <p className="mt-1">
            Each Start opens its own window and sends up to 10 applications; press Start again to add more runs at once. It finishes unfinished applications first, then searches {name} with the candidate&rsquo;s Auto-apply settings.
            Longer applications on a company&rsquo;s own site come before quick ones. If a site needs a sign-in or a verification, the run waits on that page.
          </p>
          <p className="mt-1">
            Questions the bot can&rsquo;t answer are saved under <b>Saved answers</b> on the candidate&rsquo;s{" "}
            <a className="underline" href={candidateId ? `/candidates/${candidateId}` : "/portal/profile"}>
              profile
            </a>
            ; those jobs show &ldquo;Needs attention&rdquo; and are retried on the next Start.
          </p>
        </details>
        {!extReady && <p className="text-xs text-amber-700">Connect the extension first.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}

        {apply && (
          <div className="flex flex-col gap-2">
            {apply.message && <p className="text-xs text-slate-600">{apply.message}</p>}
            <div className="flex gap-4 text-sm">
              <span>
                <b className="text-emerald-700">{apply.applied}</b> applied
              </span>
              <span>
                <b>{apply.skipped}</b> skipped
              </span>
              <span>
                <b className="text-red-700">{apply.failed}</b> need attention
              </span>
            </div>
            {apply.log.length > 0 && (
              <div className="flex max-h-72 flex-col gap-1.5 overflow-auto">
                {[...apply.log].reverse().map((l, i) => (
                  <div key={i} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-900">{l.title}</div>
                      <div className="text-xs text-slate-500">{[l.company, l.reason].filter(Boolean).join(" · ")}</div>
                    </div>
                    <Badge variant={OUTCOME_VARIANT[l.outcome] ?? "secondary"}>{l.outcome === "FAILED" ? "Needs attention" : l.outcome === "APPLIED" ? "Applied" : "Skipped"}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
