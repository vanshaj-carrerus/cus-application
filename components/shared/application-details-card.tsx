"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Details {
  workAuthorization?: string;
  requiresSponsorship?: boolean;
  willingToRelocate?: boolean;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
  linkedinUrl?: string;
  portfolioUrl?: string;
  githubUrl?: string;
  noticePeriod?: string;
  expectedSalary?: number;
  currency?: string;
}

type YesNo = "" | "yes" | "no";
const toYesNo = (v: boolean | undefined): YesNo => (v === true ? "yes" : v === false ? "no" : "");
const fromYesNo = (v: YesNo): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

const FIELDS_NEEDED: Array<[keyof Details | "address.city" | "address.country", string]> = [
  ["workAuthorization", "work authorization"],
  ["requiresSponsorship", "visa sponsorship"],
  ["address.city", "address"],
  ["noticePeriod", "notice period (in the profile section)"],
  ["expectedSalary", "expected salary (in the profile section)"],
];

/**
 * The facts application forms ask for. The auto-apply bot only ever answers a question from what is recorded
 * here — a blank means it stops and asks a person, never guesses. `endpoint` is where the candidate record lives
 * (GET returns { candidate }, PATCH saves): the recruiter route or the candidate's own.
 */
export function ApplicationDetailsCard({ endpoint, audience }: { endpoint: string; audience: "staff" | "candidate" }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({
    workAuthorization: "",
    requiresSponsorship: "" as YesNo,
    willingToRelocate: "" as YesNo,
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    linkedinUrl: "",
    portfolioUrl: "",
    githubUrl: "",
  });
  const [missing, setMissing] = useState<string[]>([]);

  const computeMissing = (c: Details) =>
    FIELDS_NEEDED.filter(([key]) => {
      if (key === "address.city") return !c.address?.city;
      if (key === "address.country") return !c.address?.country;
      const v = c[key as keyof Details];
      return v === undefined || v === null || v === "";
    }).map(([, label]) => label);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint)
      .then((r) => r.json())
      .then((d: { candidate?: Details }) => {
        if (cancelled || !d.candidate) return;
        const c = d.candidate;
        setForm({
          workAuthorization: c.workAuthorization ?? "",
          requiresSponsorship: toYesNo(c.requiresSponsorship),
          willingToRelocate: toYesNo(c.willingToRelocate),
          line1: c.address?.line1 ?? "",
          line2: c.address?.line2 ?? "",
          city: c.address?.city ?? "",
          state: c.address?.state ?? "",
          postalCode: c.address?.postalCode ?? "",
          country: c.address?.country ?? "",
          linkedinUrl: c.linkedinUrl ?? "",
          portfolioUrl: c.portfolioUrl ?? "",
          githubUrl: c.githubUrl ?? "",
        });
        setMissing(computeMissing(c));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const body = {
        workAuthorization: form.workAuthorization.trim(),
        requiresSponsorship: fromYesNo(form.requiresSponsorship),
        willingToRelocate: fromYesNo(form.willingToRelocate),
        address: { line1: form.line1.trim(), line2: form.line2.trim(), city: form.city.trim(), state: form.state.trim(), postalCode: form.postalCode.trim(), country: form.country.trim() },
        linkedinUrl: form.linkedinUrl.trim(),
        portfolioUrl: form.portfolioUrl.trim(),
        githubUrl: form.githubUrl.trim(),
      };
      for (const url of [body.linkedinUrl, body.portfolioUrl, body.githubUrl]) {
        if (url && !/^https?:\/\/\S+\.\S+/i.test(url)) throw new Error(`"${url}" isn't a full web address (it should start with https://)`);
      }
      const res = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Couldn't save (${res.status})`);
      setMissing(computeMissing(data.candidate ?? {}));
      setMessage({ ok: true, text: "Saved." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Couldn't save" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton className="h-64 w-full" />;

  const label = "mb-1 block text-xs font-medium text-slate-600";
  const select = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application details</CardTitle>
        <p className="text-xs text-slate-500">
          {audience === "staff" ? "What the application assistant fills into forms for this candidate." : "These are the facts employers' application forms ask for. We only state what is filled in here."} A blank
          field is left empty for the person applying to answer, never guessed.
        </p>
        {missing.length > 0 && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Still needed so forms can be filled automatically: {missing.join(", ")}.</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <label className={label}>Work authorization</label>
          <Input placeholder="e.g. US citizen, H-1B, Authorized to work in India" value={form.workAuthorization} onChange={set("workAuthorization")} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Needs visa sponsorship?</label>
            <select className={select} value={form.requiresSponsorship} onChange={set("requiresSponsorship")}>
              <option value="">Not specified</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div>
            <label className={label}>Willing to relocate?</label>
            <select className={select} value={form.willingToRelocate} onChange={set("willingToRelocate")}>
              <option value="">Not specified</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
        </div>

        <div className="text-xs font-medium text-slate-600">Address</div>
        <Input placeholder="Address line 1" value={form.line1} onChange={set("line1")} />
        <Input placeholder="Address line 2 (optional)" value={form.line2} onChange={set("line2")} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input placeholder="City" value={form.city} onChange={set("city")} />
          <Input placeholder="State / region" value={form.state} onChange={set("state")} />
          <Input placeholder="Postal code" value={form.postalCode} onChange={set("postalCode")} />
          <Input placeholder="Country" value={form.country} onChange={set("country")} />
        </div>

        <div className="text-xs font-medium text-slate-600">Links (optional)</div>
        <Input placeholder="https://www.linkedin.com/in/…" value={form.linkedinUrl} onChange={set("linkedinUrl")} />
        <Input placeholder="Portfolio / website" value={form.portfolioUrl} onChange={set("portfolioUrl")} />
        <Input placeholder="https://github.com/…" value={form.githubUrl} onChange={set("githubUrl")} />

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save details"}
          </Button>
          {message && <span className={`text-xs ${message.ok ? "text-emerald-600" : "text-red-600"}`}>{message.text}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
