"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Health {
  database?: { status: string; error?: string };
  jobApi?: { lastSync: { status: string; at: string; fetched: number } | null };
  aiApi?: { status: string; failedRequests: number; totalRequests: number };
}

interface MemberStats {
  userId: string;
  name: string;
  today: number;
  week: number;
  month: number;
  total: number;
}

export default function AdminPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [members, setMembers] = useState<MemberStats[] | null>(null);
  const [queue, setQueue] = useState<{ ready: number; inBrowser: number; needsPreparing: number } | null>(null);
  const [topCandidates, setTopCandidates] = useState<Array<{ candidateId: string; name: string; week: number; total: number }>>([]);

  useEffect(() => {
    fetch("/api/system/health")
      .then((r) => r.json())
      .then(setHealth);
    fetch("/api/analytics/marketing")
      .then((r) => r.json())
      .then((d) => {
        setMembers(d.members ?? []);
        setQueue(d.queue ?? null);
        setTopCandidates(d.topCandidates ?? []);
      })
      .catch(() => setMembers([]));
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Admin — System Monitoring</h1>

      {!health ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatusCard label="Database" status={health.database?.status} />
          <StatusCard label="Job API" status={health.jobApi?.lastSync?.status ?? "NO SYNC YET"} />
          <StatusCard label="AI API" status={health.aiApi?.status} />
        </div>
      )}

      {health?.aiApi && (
        <Card>
          <CardHeader>
            <CardTitle>AI Usage</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-6 text-sm">
            <div>
              <div className="text-xl font-semibold">{health.aiApi.totalRequests}</div>
              <div className="text-xs text-slate-500">Total AI analyses</div>
            </div>
            <div>
              <div className="text-xl font-semibold">{health.aiApi.failedRequests}</div>
              <div className="text-xs text-slate-500">Failed</div>
            </div>
          </CardContent>
        </Card>
      )}

      {health?.jobApi?.lastSync && (
        <Card>
          <CardHeader>
            <CardTitle>Last Job Sync</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-slate-700">
            {health.jobApi.lastSync.status} — {health.jobApi.lastSync.fetched} jobs fetched at{" "}
            {new Date(health.jobApi.lastSync.at).toLocaleString()}
          </CardContent>
        </Card>
      )}

      {queue && (
        <div className="grid grid-cols-3 gap-3">
          <StatusTile label="Ready to apply" value={queue.ready} />
          <StatusTile label="Open in a browser" value={queue.inBrowser} />
          <StatusTile label="Needs preparing" value={queue.needsPreparing} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Applications submitted per team member</CardTitle>
        </CardHeader>
        <CardContent>
          {members === null ? (
            <Skeleton className="h-16 w-full" />
          ) : members.length === 0 ? (
            <p className="text-sm text-slate-500">No applications have been submitted through the apply queue yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 font-medium">Team member</th>
                  <th className="py-1 text-right font-medium">Today</th>
                  <th className="py-1 text-right font-medium">Last 7 days</th>
                  <th className="py-1 text-right font-medium">Last 30 days</th>
                  <th className="py-1 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} className="border-t border-slate-100">
                    <td className="py-1.5">{m.name}</td>
                    <td className="py-1.5 text-right">{m.today}</td>
                    <td className="py-1.5 text-right">{m.week}</td>
                    <td className="py-1.5 text-right">{m.month}</td>
                    <td className="py-1.5 text-right font-medium">{m.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {topCandidates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Candidates with the most applications</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 font-medium">Candidate</th>
                  <th className="py-1 text-right font-medium">Last 7 days</th>
                  <th className="py-1 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {topCandidates.map((c) => (
                  <tr key={c.candidateId} className="border-t border-slate-100">
                    <td className="py-1.5">
                      <a href={`/candidates/${c.candidateId}`} className="hover:underline">
                        {c.name}
                      </a>
                    </td>
                    <td className="py-1.5 text-right">{c.week}</td>
                    <td className="py-1.5 text-right font-medium">{c.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>User Management</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          See the <a href="/recruiters" className="underline">Team</a> page to view all users. Creating and role-editing
          users is available via the <code className="rounded bg-slate-100 px-1">/api/users</code> API for SUPER_ADMIN/ADMIN roles.
        </CardContent>
      </Card>
    </div>
  );
}

function StatusTile({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xl font-semibold text-slate-900">{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </CardContent>
    </Card>
  );
}

function StatusCard({ label, status }: { label: string; status?: string }) {
  const up = status === "UP" || status === "SUCCESS";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-slate-500">{label}</div>
        <Badge variant={up ? "success" : "danger"} className="mt-1">
          {status ?? "UNKNOWN"}
        </Badge>
      </CardContent>
    </Card>
  );
}
