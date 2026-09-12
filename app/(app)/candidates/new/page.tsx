"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function NewCandidatePage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    location: "",
    skills: "",
    expectedSalary: "",
    currency: "",
    noticePeriod: "",
    preferredRoles: "",
    preferredLocations: "",
  });

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email || undefined,
          phone: form.phone || undefined,
          location: form.location || undefined,
          skills: splitList(form.skills),
          expectedSalary: form.expectedSalary ? Number(form.expectedSalary) : undefined,
          currency: form.currency || undefined,
          noticePeriod: form.noticePeriod || undefined,
          preferredRoles: splitList(form.preferredRoles),
          preferredLocations: splitList(form.preferredLocations),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create candidate");
        return;
      }
      router.push(`/candidates/${data.candidate._id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Add Candidate</h1>

      <Card>
        <CardHeader>
          <CardTitle>Candidate details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Name *</label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
                <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Phone</label>
                <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Location</label>
              <Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="City, State, Country" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Skills (comma-separated)</label>
              <Input value={form.skills} onChange={(e) => set("skills", e.target.value)} placeholder="React, Node.js, MongoDB" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Expected Salary</label>
                <Input type="number" value={form.expectedSalary} onChange={(e) => set("expectedSalary", e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Currency</label>
                <Input value={form.currency} onChange={(e) => set("currency", e.target.value)} placeholder="INR, USD" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Notice Period</label>
              <Input value={form.noticePeriod} onChange={(e) => set("noticePeriod", e.target.value)} placeholder="e.g. 30 days" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Preferred Roles (comma-separated)</label>
              <Input value={form.preferredRoles} onChange={(e) => set("preferredRoles", e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Preferred Locations (comma-separated)</label>
              <Input value={form.preferredLocations} onChange={(e) => set("preferredLocations", e.target.value)} />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => router.push("/candidates")}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Create Candidate"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
