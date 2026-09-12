"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { JOB_BOARDS } from "@/lib/models/enums";

interface CredentialRow {
  board: string;
  hostname?: string;
  boardUsername: string;
  status: string;
  lastError?: string;
}

export default function PortalCredentialsPage() {
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [board, setBoard] = useState<string>(JOB_BOARDS[0]);
  const [hostname, setHostname] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch("/api/portal/credentials")
      .then((r) => r.json())
      .then((d) => setCredentials(d.credentials ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/portal/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board, hostname: board === "OTHER" ? hostname : undefined, boardUsername: username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      setUsername("");
      setPassword("");
      setHostname("");
      load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(c: CredentialRow) {
    const params = new URLSearchParams({ board: c.board });
    if (c.hostname) params.set("hostname", c.hostname);
    await fetch(`/api/portal/credentials?${params.toString()}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Job Board & Application Logins</h1>
        <p className="text-sm text-slate-500">
          Some applications require signing into a job board, or into the employer&apos;s own application system. Add logins here so the auto-apply worker
          can sign in on your behalf when it hits one — stored encrypted and never shown back to anyone, including you, after saving.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add / Update a Login</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Site</label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm" value={board} onChange={(e) => setBoard(e.target.value)}>
                {JOB_BOARDS.map((b) => (
                  <option key={b} value={b}>
                    {b === "OTHER" ? "Other (a specific employer's application site)" : b}
                  </option>
                ))}
              </select>
            </div>
            {board === "OTHER" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Site domain</label>
                <Input
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="e.g. boards.greenhouse.io or myworkdayjobs.com"
                  required
                />
                <p className="mt-1 text-xs text-slate-400">
                  This is the login used whenever an application on this domain asks you to sign in — check the address bar on that page.
                </p>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Username / Email</label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Password</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Login"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Saved Logins</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : credentials.length === 0 ? (
            <p className="text-sm text-slate-500">No logins saved yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {credentials.map((c) => (
                <div key={`${c.board}-${c.hostname ?? ""}`} className="flex items-center justify-between rounded-md border border-slate-200 p-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{c.board === "OTHER" ? c.hostname : c.board}</div>
                    <div className="text-xs text-slate-500">{c.boardUsername}</div>
                    {c.lastError && <div className="text-xs text-red-500">{c.lastError}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={c.status === "ACTIVE" ? "success" : "danger"}>{c.status}</Badge>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(c)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
