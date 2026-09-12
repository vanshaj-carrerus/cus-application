"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface CandidateProfile {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  expectedSalary?: number;
  currency?: string;
  noticePeriod?: string;
  preferredRoles: string[];
  preferredLocations: string[];
}

function joinList(list: string[] | undefined) {
  return (list ?? []).join(", ");
}
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function PortalProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [form, setForm] = useState({
    phone: "",
    location: "",
    expectedSalary: "",
    currency: "",
    noticePeriod: "",
    preferredRoles: "",
    preferredLocations: "",
  });

  useEffect(() => {
    fetch("/api/portal/me")
      .then((r) => r.json())
      .then((d) => {
        const c = d.candidate as CandidateProfile;
        setCandidate(c);
        setForm({
          phone: c.phone ?? "",
          location: c.location ?? "",
          expectedSalary: c.expectedSalary != null ? String(c.expectedSalary) : "",
          currency: c.currency ?? "",
          noticePeriod: c.noticePeriod ?? "",
          preferredRoles: joinList(c.preferredRoles),
          preferredLocations: joinList(c.preferredLocations),
        });
      })
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/portal/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: form.phone || undefined,
          location: form.location || undefined,
          expectedSalary: form.expectedSalary ? Number(form.expectedSalary) : undefined,
          currency: form.currency || undefined,
          noticePeriod: form.noticePeriod || undefined,
          preferredRoles: splitList(form.preferredRoles),
          preferredLocations: splitList(form.preferredLocations),
        }),
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton className="h-64 w-full max-w-2xl" />;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">My Profile</h1>

      <Card>
        <CardHeader>
          <CardTitle>Contact & Preferences</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Name</label>
              <Input value={candidate?.name ?? ""} disabled />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
              <Input value={candidate?.email ?? ""} disabled />
            </div>
          </div>
          <p className="text-xs text-slate-400">Name and email are managed by your recruiter — contact them to update these.</p>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Phone</label>
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Location</label>
            <Input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Expected Salary</label>
              <Input type="number" value={form.expectedSalary} onChange={(e) => setForm((f) => ({ ...f, expectedSalary: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Currency</label>
              <Input value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Notice Period</label>
            <Input value={form.noticePeriod} onChange={(e) => setForm((f) => ({ ...f, noticePeriod: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Preferred Roles (comma-separated)</label>
            <Input value={form.preferredRoles} onChange={(e) => setForm((f) => ({ ...f, preferredRoles: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Preferred Locations (comma-separated)</label>
            <Input value={form.preferredLocations} onChange={(e) => setForm((f) => ({ ...f, preferredLocations: e.target.value }))} />
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
            {saved && <span className="text-xs text-emerald-600">Saved.</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
