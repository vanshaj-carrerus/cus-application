"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LinkedInData } from "@/components/shared/linkedin-data";
import { HelperSetup, requestPortalApply } from "@/components/shared/helper-setup";
import type { ApplyRunView } from "@/components/shared/portal-apply";
import { PortalApplyPanel } from "@/components/shared/portal-apply-panel";
import { PORTAL_CATALOG, type PortalDef, type PortalRegion } from "@/lib/portals/catalog";

interface Connection {
  _id: string;
  portal: string;
  loginId: string;
  status: string;
  statusNote?: string;
  profileUrl?: string;
  updatedAt: string;
}

const REGION_FILTERS: { key: PortalRegion | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "USA", label: "USA" },
  { key: "INDIA", label: "India" },
];

const STATUS_BADGE: Record<string, { label: string; variant: "success" | "warning" | "danger" | "secondary" }> = {
  PENDING: { label: "Saved · not verified", variant: "secondary" },
  ACTIVE: { label: "Connected", variant: "success" },
  NEEDS_2FA: { label: "Needs 2FA", variant: "warning" },
  INVALID: { label: "Invalid login", variant: "danger" },
  LOCKED: { label: "Locked", variant: "danger" },
};

/** Connect a candidate's job-portal accounts. `candidateId` is omitted for a candidate login (the server uses the session). */
export function PortalsPanel({ candidateId }: { candidateId?: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState<PortalRegion | "ALL">("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ loginId: "", password: "", profileUrl: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ext, setExt] = useState<{ installed: boolean; paired: boolean } | null>(null);
  // The one portal whose full detail (progress, log, data) is showing; every other portal is just its card.
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ApplyRunView | null>>({});
  const [runsTick, setRunsTick] = useState(0);
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ portal: string; message: string } | null>(null);

  const query = candidateId ? `?candidateId=${candidateId}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/portals/connections${query}`);
      const data = await res.json();
      setConnections(data.connections ?? []);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  function open(portal: PortalDef) {
    const existing = connections.find((c) => c.portal === portal.id);
    setOpenId(portal.id);
    setError(null);
    setForm({ loginId: existing?.loginId ?? "", password: "", profileUrl: existing?.profileUrl ?? "" });
  }

  async function save(portal: PortalDef) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/portals/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, portal: portal.id, ...form }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save");
        return;
      }
      setOpenId(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function disconnect(c: Connection) {
    if (!confirm("Disconnect this account?")) return;
    await fetch(`/api/portals/connections/${c._id}`, { method: "DELETE" });
    await load();
  }

  // Connected portals the extension can work on.
  const connectedRunners = PORTAL_CATALOG.filter((p) => (p.autoApply || p.extensionSync) && connections.some((c) => c.portal === p.id));
  const runnerKey = connectedRunners.map((p) => p.id).join(",");
  const anyActive = Object.values(runs).some((r) => r?.state === "RUNNING" || r?.state === "PAUSED" || r?.state === "STOPPING");

  // Each card shows whether its portal has a run going. Looks again every few seconds while one does, and whenever a run is started.
  useEffect(() => {
    let alive = true;
    const ids = runnerKey ? runnerKey.split(",") : [];
    const fetchRuns = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`/api/portals/snapshots?portal=${id}${candidateId ? `&candidateId=${candidateId}` : ""}`);
          return [id, res.ok ? ((await res.json()).apply as ApplyRunView | null) : null] as const;
        })
      );
      if (alive) setRuns(Object.fromEntries(entries));
    };
    fetchRuns();
    const timer = anyActive ? setInterval(fetchRuns, 4_000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [runnerKey, candidateId, anyActive, runsTick]);

  async function startRun(portal: PortalDef) {
    setStarting(portal.id);
    setStartError(null);
    try {
      const r = await requestPortalApply(portal.id, candidateId);
      if (!r.ok) setStartError({ portal: portal.id, message: r.error ?? "Could not start" });
      else setSelected(portal.id); // show its progress
      setRunsTick((n) => n + 1);
    } finally {
      setStarting(null);
    }
  }

  const visible = PORTAL_CATALOG.filter((p) => region === "ALL" || p.regions.includes(region));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {REGION_FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={region === f.key ? "default" : "outline"} onClick={() => setRegion(f.key)}>
            {f.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-slate-500">
          {connections.length} of {PORTAL_CATALOG.length} connected
        </span>
      </div>

      <p className="text-xs text-slate-500">
        Passwords are encrypted before they are stored and are never shown again. LinkedIn is read through the browser extension and becomes &ldquo;Connected&rdquo;
        after its first successful sync; other portals stay &ldquo;not verified&rdquo; until sign-in checks are added.
      </p>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((portal) => {
            const conn = connections.find((c) => c.portal === portal.id);
            const badge = conn ? STATUS_BADGE[conn.status] ?? STATUS_BADGE.PENDING : null;
            const isOpen = openId === portal.id;
            return (
              <Card key={portal.id}>
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{portal.name}</div>
                      <div className="text-xs text-slate-500">{portal.regions.map((r) => (r === "GLOBAL" ? "Global" : r === "USA" ? "USA" : "India")).join(" · ")}</div>
                    </div>
                    {runs[portal.id] && ["RUNNING", "PAUSED", "STOPPING"].includes(runs[portal.id]!.state) ? (
                      <Badge variant={runs[portal.id]!.state === "PAUSED" ? "warning" : "info"}>
                        {runs[portal.id]!.state === "PAUSED" ? "Needs you" : (runs[portal.id]!.activeRuns ?? 1) > 1 ? `${runs[portal.id]!.activeRuns} runs` : "Running"}
                      </Badge>
                    ) : (
                      badge && <Badge variant={badge.variant}>{badge.label}</Badge>
                    )}
                  </div>

                  {conn && !isOpen && (
                    <div className="text-xs text-slate-600">
                      Signed in as <span className="font-medium">{conn.loginId}</span>
                      {conn.statusNote && <div className="mt-1 text-slate-500">{conn.statusNote}</div>}
                    </div>
                  )}
                  {portal.note && !conn && !isOpen && <div className="text-xs text-slate-500">{portal.note}</div>}

                  {isOpen ? (
                    <div className="flex flex-col gap-2">
                      <Input placeholder={portal.loginLabel} value={form.loginId} onChange={(e) => setForm({ ...form, loginId: e.target.value })} autoComplete="off" />
                      <Input
                        type="password"
                        placeholder={portal.extensionSync || portal.loginInBrowser ? "Password (optional, not needed: you sign in in your browser)" : conn ? "New password" : "Password"}
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                        autoComplete="new-password"
                      />
                      <Input placeholder={portal.profileUrlRequired ? "Profile URL (required)" : "Profile URL (optional)"} value={form.profileUrl} onChange={(e) => setForm({ ...form, profileUrl: e.target.value })} />
                      {error && <div className="text-xs text-red-600">{error}</div>}
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => save(portal)} disabled={saving}>
                          {saving ? "Saving…" : "Save"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setOpenId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant={conn ? "outline" : "default"} onClick={() => open(portal)}>
                        <Link2 className="mr-1 h-3.5 w-3.5" />
                        {conn ? "Update" : "Connect"}
                      </Button>
                      {conn && portal.autoApply && (
                        <Button size="sm" onClick={() => startRun(portal)} disabled={starting === portal.id || !ext?.paired} title={ext?.paired ? undefined : "Connect the extension first"}>
                          <Play className="mr-1 h-3.5 w-3.5" />
                          Start
                        </Button>
                      )}
                      {conn && (portal.autoApply || portal.extensionSync) && (
                        <Button size="sm" variant="outline" onClick={() => setSelected(selected === portal.id ? null : portal.id)}>
                          {selected === portal.id ? "Hide" : "Details"}
                        </Button>
                      )}
                      {conn && (
                        <Button size="sm" variant="outline" onClick={() => disconnect(conn)} aria-label="Disconnect">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <a href={portal.loginUrl} target="_blank" rel="noreferrer" className="ml-auto text-slate-400 hover:text-slate-700" aria-label={`Open ${portal.name}`}>
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  )}
                  {startError?.portal === portal.id && <div className="text-xs text-red-600">{startError.message}</div>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Extension status stays one quiet line; the detail below is only for the portal that was selected. */}
      {connectedRunners.length > 0 && <HelperSetup onStatus={setExt} compact />}
      {selected === "LINKEDIN" && connections.some((c) => c.portal === "LINKEDIN") && <LinkedInData key={`li-${candidateId ?? "self"}`} candidateId={candidateId} ext={ext} />}
      {selected && selected !== "LINKEDIN" && connectedRunners.some((p) => p.id === selected) && (
        <PortalApplyPanel key={`${selected}-${candidateId ?? "self"}`} portal={selected} name={PORTAL_CATALOG.find((p) => p.id === selected)?.name ?? selected} candidateId={candidateId} extReady={!!ext?.paired} />
      )}
    </div>
  );
}
