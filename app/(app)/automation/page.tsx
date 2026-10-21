"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface HostStats {
  host: string;
  hostClass: "ATS" | "EMPLOYER" | "AGGREGATOR" | "BOARD" | "SESSION";
  attempts: number;
  applied: number;
  handedOff: number;
  failed: number;
  dryRun: number;
  inProgress: number;
  successRate: number | null;
  emailConfirmed: number;
  topReasons: Array<{ reason: string; count: number }>;
  lastAttemptAt: string | null;
  advice: string | null;
}

interface Stats {
  days: number;
  totals: { attempts: number; applied: number; handedOff: number; failed: number; dryRun: number; inProgress: number; successRate: number | null; emailConfirmed: number };
  hosts: HostStats[];
  topReasons: Array<{ reason: string; count: number }>;
}

const CLASS_LABEL: Record<HostStats["hostClass"], { label: string; variant: "success" | "info" | "warning" | "secondary" | "danger" }> = {
  ATS: { label: "ATS", variant: "success" },
  EMPLOYER: { label: "Company site", variant: "info" },
  BOARD: { label: "Job board", variant: "secondary" },
  AGGREGATOR: { label: "Aggregator", variant: "secondary" },
  SESSION: { label: "Needs session", variant: "warning" },
};

const RANGES = [7, 30, 90];

function rateBadge(rate: number | null) {
  if (rate === null) return <span className="text-slate-400">—</span>;
  const variant = rate >= 70 ? "success" : rate >= 40 ? "warning" : "danger";
  return <Badge variant={variant}>{rate}%</Badge>;
}

export default function AutomationPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/automation/stats?days=${days}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
        return body as Stats;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load stats"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Auto-apply performance</h1>
          <p className="text-sm text-slate-500">
            How the bot is doing on each site. &ldquo;Handed to a person&rdquo; means it stopped on purpose (login, CAPTCHA, a question it can&apos;t answer, or a site it doesn&apos;t apply on). Test runs are
            shown separately and never count against a site.
          </p>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => {
                setLoading(true);
                setDays(r);
              }}
              className={`rounded-md border px-3 py-1 text-xs ${days === r ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              {r} days
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !data || loading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {(
              [
                ["Attempts", data.totals.attempts],
                ["Applied", data.totals.applied],
                ["Email-confirmed", data.totals.emailConfirmed],
                ["Handed to a person", data.totals.handedOff],
                ["Failed", data.totals.failed],
                ["Test runs", data.totals.dryRun],
                ["Success rate", data.totals.successRate === null ? "—" : `${data.totals.successRate}%`],
              ] as Array<[string, number | string]>
            ).map(([label, value]) => (
              <Card key={label}>
                <CardContent className="p-4">
                  <div className="text-xl font-semibold">{value}</div>
                  <div className="text-xs text-slate-500">{label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>By site</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {data.hosts.length === 0 ? (
                <p className="text-sm text-slate-500">No attempts in the last {data.days} days.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="py-2 pr-3 font-medium">Site</th>
                      <th className="py-2 pr-3 font-medium">Type</th>
                      <th className="py-2 pr-3 text-right font-medium">Attempts</th>
                      <th className="py-2 pr-3 text-right font-medium">Applied</th>
                      <th className="py-2 pr-3 text-right font-medium">Handed off</th>
                      <th className="py-2 pr-3 text-right font-medium">Failed</th>
                      <th className="py-2 pr-3 text-right font-medium">Test</th>
                      <th className="py-2 pr-3 font-medium">Success</th>
                      <th className="py-2 font-medium">Why it stops</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hosts.map((h) => (
                      <tr key={h.host} className="border-b border-slate-100 align-top">
                        <td className="py-2 pr-3 font-medium text-slate-900">{h.host}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={CLASS_LABEL[h.hostClass].variant}>{CLASS_LABEL[h.hostClass].label}</Badge>
                        </td>
                        <td className="py-2 pr-3 text-right">{h.attempts}</td>
                        <td className="py-2 pr-3 text-right">
                          {h.applied}
                          {h.emailConfirmed > 0 && <span className="text-xs text-emerald-600"> ({h.emailConfirmed}✓)</span>}
                        </td>
                        <td className="py-2 pr-3 text-right">{h.handedOff}</td>
                        <td className="py-2 pr-3 text-right">{h.failed}</td>
                        <td className="py-2 pr-3 text-right text-slate-400">{h.dryRun}</td>
                        <td className="py-2 pr-3">{rateBadge(h.successRate)}</td>
                        <td className="py-2 text-xs text-slate-600">
                          {h.topReasons.length === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <ul className="flex flex-col gap-0.5">
                              {h.topReasons.map((r) => (
                                <li key={r.reason}>
                                  <span className="font-medium">{r.count}×</span> {r.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                          {h.advice && <div className="mt-1 text-amber-700">→ {h.advice}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {data.topReasons.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Most common reasons it stops</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-sm text-slate-700">
                  {data.topReasons.map((r) => (
                    <li key={r.reason}>
                      <span className="font-medium">{r.count}×</span> {r.reason}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
