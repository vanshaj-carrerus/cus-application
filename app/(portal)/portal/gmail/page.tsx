"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface GmailStatus {
  connected: boolean;
  emailAddress?: string;
  status?: string;
  lastError?: string;
  connectedAt?: string;
}

interface RecentMessage {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  sentAt: string;
}

function PortalGmailContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<GmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [recent, setRecent] = useState<RecentMessage[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch("/api/portal/gmail")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        if (d?.connected) loadRecent();
      })
      .finally(() => setLoading(false));
  };

  const loadRecent = () => {
    setRecentLoading(true);
    setRecentError(null);
    fetch("/api/portal/gmail/recent")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setRecentError(d.error);
          return;
        }
        setRecent(d.messages ?? []);
      })
      .catch(() => setRecentError("Failed to load recent emails"))
      .finally(() => setRecentLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await fetch("/api/portal/gmail", { method: "DELETE" });
      setRecent(null);
      load();
    } finally {
      setDisconnecting(false);
    }
  }

  const connectStatus = searchParams.get("gmail");
  const connectError = searchParams.get("gmail_error");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Email Access</h1>
        <p className="text-sm text-slate-500">
          Some applications ask you to verify your email during sign-up with a one-time code. Connecting your Gmail lets the
          auto-apply worker read that code and complete the application without waiting on you. We only ever read
          verification-related messages — we never see or store anything else in your inbox.
        </p>
      </div>

      {connectStatus === "connected" && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-4 text-sm text-emerald-800">Gmail connected successfully.</CardContent>
        </Card>
      )}
      {connectStatus === "error" && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-800">Couldn&apos;t connect Gmail{connectError ? `: ${connectError}` : "."}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Gmail Connection</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : data?.connected ? (
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <div>
                <div className="text-sm font-medium text-slate-900">{data.emailAddress}</div>
                {data.lastError && <div className="text-xs text-red-500">{data.lastError}</div>}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="success">Connected</Badge>
                <Button variant="ghost" size="sm" disabled={disconnecting} onClick={handleDisconnect}>
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-slate-500">You haven&apos;t connected a Gmail account yet.</p>
              <Button asChild>
                <a href="/api/portal/gmail/connect">Connect with Google</a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {data?.connected && (
        <Card>
          <CardHeader>
            <CardTitle>Latest 5 Emails</CardTitle>
          </CardHeader>
          <CardContent>
            {recentLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : recentError ? (
              <p className="text-sm text-red-600">{recentError}</p>
            ) : !recent || recent.length === 0 ? (
              <p className="text-sm text-slate-500">No inbox messages found.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {recent.map((m) => (
                  <div key={m.id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-slate-900">{m.subject}</div>
                      <div className="whitespace-nowrap text-xs text-slate-400">{new Date(m.sentAt).toLocaleString()}</div>
                    </div>
                    <div className="text-xs text-slate-500">{m.from}</div>
                    <div className="mt-1 truncate text-xs text-slate-400">{m.snippet}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function PortalGmailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full max-w-2xl" />}>
      <PortalGmailContent />
    </Suspense>
  );
}
