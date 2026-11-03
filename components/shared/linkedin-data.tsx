"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requestPortalSync } from "@/components/shared/helper-setup";
import { PortalApplyCard, type ApplyRunView } from "@/components/shared/portal-apply";
import type { LinkedInJob, LinkedInProfile, LinkedInThread } from "@/lib/portals/linkedin";

interface Snapshot {
  sections: {
    profile?: { data: LinkedInProfile; syncedAt: string };
    messages?: { data: LinkedInThread[]; syncedAt: string };
    jobs?: { data: LinkedInJob[]; syncedAt: string };
  };
  run: { state: "RUNNING" | "DONE" | "FAILED"; message?: string; startedAt: string } | null;
  apply: ApplyRunView | null;
}

type Tab = "profile" | "messages" | "jobs";
const TABS: { key: Tab; label: string }[] = [
  { key: "profile", label: "Profile" },
  { key: "messages", label: "Messages" },
  { key: "jobs", label: "Jobs" },
];

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "never");

/** A candidate's LinkedIn data as last read from their own signed-in browser, with a Sync button. */
export function LinkedInData({ candidateId, ext }: { candidateId?: string; ext: { installed: boolean; paired: boolean } | null }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>("profile");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = `?portal=LINKEDIN${candidateId ? `&candidateId=${candidateId}` : ""}`;
  const load = useCallback(async () => {
    const res = await fetch(`/api/portals/snapshots${query}`);
    if (res.ok) setSnap(await res.json());
  }, [query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  const running = snap?.run?.state === "RUNNING";
  const applying = snap?.apply?.state === "RUNNING" || snap?.apply?.state === "PAUSED" || snap?.apply?.state === "STOPPING";
  useEffect(() => {
    if (!running && !applying) return;
    const timer = setInterval(load, 3_000);
    return () => clearInterval(timer);
  }, [running, applying, load]);

  async function sync() {
    setStarting(true);
    setError(null);
    try {
      const r = await requestPortalSync("LINKEDIN", candidateId);
      if (!r.ok) setError(r.error ?? "Could not start the sync");
      await load();
    } finally {
      setStarting(false);
    }
  }

  const profile = snap?.sections.profile?.data;
  const threads = snap?.sections.messages?.data ?? [];
  const jobs = snap?.sections.jobs?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PortalApplyCard portal="LINKEDIN" name="LinkedIn" candidateId={candidateId} apply={snap?.apply ?? null} extReady={!!ext?.paired} reload={load} />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-slate-900">LinkedIn data</div>
            {snap?.run?.state === "FAILED" && <Badge variant="danger">Last sync failed</Badge>}
            {running && <Badge variant="info">Syncing…</Badge>}
            <Button size="sm" className="ml-auto" onClick={sync} disabled={starting || running || !ext?.paired}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
              {running ? "Syncing" : "Sync from LinkedIn"}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            {candidateId ? "Run this on the candidate's own computer, " : "Run this "}signed in to the connected LinkedIn account in this browser. A LinkedIn tab opens, reads the profile, recent
            conversations and saved or applied jobs, then closes. Keep it open until it finishes.
          </p>
          {!ext?.paired && ext && <p className="text-xs text-amber-700">Connect the extension above first.</p>}
          {(error || snap?.run?.state === "FAILED") && <p className="text-xs text-red-600">{error ?? snap?.run?.message}</p>}
          {running && snap?.run?.message && <p className="text-xs text-slate-600">{snap.run.message}</p>}

          <div className="flex gap-1 border-b border-slate-200">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-2 text-sm ${tab === t.key ? "border-b-2 border-slate-900 font-medium text-slate-900" : "text-slate-500 hover:text-slate-800"}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "profile" &&
            (profile ? (
              <div className="flex flex-col gap-4 text-sm">
                <div>
                  <a href={profile.url} target="_blank" rel="noreferrer" className="text-base font-semibold text-slate-900 hover:underline">
                    {profile.name}
                  </a>
                  {profile.headline && <div className="text-slate-700">{profile.headline}</div>}
                  {profile.location && <div className="text-xs text-slate-500">{profile.location}</div>}
                  <div className="mt-1 text-xs text-slate-400">Updated {when(snap?.sections.profile?.syncedAt)}</div>
                </div>
                {profile.about && <Block title="About">{profile.about}</Block>}
                <Entries title="Experience" items={profile.experience} />
                <Entries title="Education" items={profile.education} />
                {profile.skills.length > 0 && (
                  <Block title="Skills">
                    <div className="flex flex-wrap gap-1.5">
                      {profile.skills.map((s) => (
                        <Badge key={s} variant="secondary">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </Block>
                )}
              </div>
            ) : (
              <Empty />
            ))}

          {tab === "messages" &&
            (threads.length ? (
              <div className="flex flex-col gap-3">
                <div className="text-xs text-slate-400">Most recent {threads.length} conversations · updated {when(snap?.sections.messages?.syncedAt)}</div>
                {threads.map((t, i) => (
                  <details key={i} className="rounded-md border border-slate-200 p-3">
                    <summary className="cursor-pointer text-sm">
                      <span className="font-medium text-slate-900">{t.with}</span>
                      {t.time && <span className="ml-2 text-xs text-slate-400">{t.time}</span>}
                      {t.snippet && <div className="mt-0.5 truncate text-xs text-slate-500">{t.snippet}</div>}
                    </summary>
                    <div className="mt-3 flex flex-col gap-2">
                      {t.messages.length === 0 && <div className="text-xs text-slate-400">No message text could be read for this conversation.</div>}
                      {t.messages.map((m, j) => (
                        <div key={j} className="text-sm">
                          <span className="font-medium text-slate-800">{m.sender}</span>
                          {m.time && <span className="ml-2 text-xs text-slate-400">{m.time}</span>}
                          <div className="whitespace-pre-wrap text-slate-700">{m.text}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <Empty />
            ))}

          {tab === "jobs" &&
            (snap?.sections.jobs ? (
              jobs.length ? (
                <div className="flex flex-col gap-2">
                  <div className="text-xs text-slate-400">Updated {when(snap.sections.jobs.syncedAt)}</div>
                  {jobs.map((j, i) => (
                    <div key={`${j.jobId}-${i}`} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3 text-sm">
                      <div>
                        {j.url ? (
                          <a href={j.url} target="_blank" rel="noreferrer" className="font-medium text-slate-900 hover:underline">
                            {j.title}
                          </a>
                        ) : (
                          <span className="font-medium text-slate-900">{j.title}</span>
                        )}
                        <div className="text-xs text-slate-500">{[j.company, j.location].filter(Boolean).join(" · ")}</div>
                      </div>
                      <Badge variant={j.list === "APPLIED" ? "success" : "secondary"}>{j.list === "APPLIED" ? "Applied" : "Saved"}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">No saved or applied jobs were found on this LinkedIn account.</p>
              )
            ) : (
              <Empty />
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-slate-500">Nothing synced yet. Click &ldquo;Sync from LinkedIn&rdquo;.</p>;
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="whitespace-pre-wrap text-slate-700">{children}</div>
    </div>
  );
}

function Entries({ title, items }: { title: string; items: LinkedInProfile["experience"] }) {
  if (!items.length) return null;
  return (
    <Block title={title}>
      <div className="flex flex-col gap-3">
        {items.map((e, i) => (
          <div key={i}>
            <div className="font-medium text-slate-900">{e.title}</div>
            {e.subtitle && <div className="text-slate-700">{e.subtitle}</div>}
            {e.meta && <div className="text-xs text-slate-500">{e.meta}</div>}
            {e.details?.map((d, j) => (
              <div key={j} className="text-xs text-slate-600">
                {d}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Block>
  );
}
