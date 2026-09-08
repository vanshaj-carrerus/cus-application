"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Health {
  database?: { status: string; error?: string };
  redis?: { status: string; error?: string };
  jobApi?: { lastSync: { status: string; at: string; fetched: number } | null };
  aiApi?: { status: string; failedRequests: number; totalRequests: number };
}

export default function AdminPage() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/system/health")
      .then((r) => r.json())
      .then(setHealth);
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Admin — System Monitoring</h1>

      {!health ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatusCard label="Database" status={health.database?.status} />
          <StatusCard label="Redis / Queues" status={health.redis?.status} />
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
