"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { JOB_BOARDS } from "@/lib/models/enums";

const DEFAULT_OPTION = "__default__";

interface CredentialRow {
  board: string;
  hostname?: string;
  boardUsername: string;
  status: string;
  lastError?: string;
}

function isDefaultRow(c: CredentialRow) {
  return c.board === "OTHER" && !c.hostname;
}

export default function PortalCredentialsPage() {
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [site, setSite] = useState<string>(DEFAULT_OPTION);
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

  const hasDefault = credentials.some(isDefaultRow);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const isDefault = site === DEFAULT_OPTION;
      const res = await fetch("/api/portal/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isDefault,
          board: isDefault ? undefined : site,
          hostname: !isDefault && site === "OTHER" ? hostname : undefined,
          boardUsername: username,
          password,
        }),
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
          Some applications require signing into a job board, or into the employer&apos;s own application system. Save a{" "}
          <strong>default login</strong> below and the auto-apply worker will try it anywhere it hits a sign-in wall — you only have to set up one. If a
          specific platform needs a different email/password, add an override for just that one; it takes priority over the default there.
        </p>
      </div>

      {!hasDefault && !loading && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-800">
            You don&apos;t have a default login set yet — the worker won&apos;t be able to get past a sign-in wall on any platform you haven&apos;t added
            individually below.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add / Update a Login</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Applies to</label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm" value={site} onChange={(e) => setSite(e.target.value)}>
                <option value={DEFAULT_OPTION}>Default — use for every platform unless overridden below</option>
                {JOB_BOARDS.map((b) => (
                  <option key={b} value={b}>
                    {b === "OTHER" ? "A specific employer's application site (override)" : `${b} (override)`}
                  </option>
                ))}
              </select>
            </div>
            {site === "OTHER" && (
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
              <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
              <Input type="email" value={username} onChange={(e) => setUsername(e.target.value)} required />
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
                    <div className="text-sm font-medium text-slate-900">
                      {isDefaultRow(c) ? "Default (all platforms)" : c.board === "OTHER" ? c.hostname : c.board}
                    </div>
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
