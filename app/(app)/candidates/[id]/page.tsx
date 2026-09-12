"use client";

import { useEffect, useState, useCallback, use } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { JOB_BOARDS } from "@/lib/models/enums";

interface CandidateDetail {
  _id: string;
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  skills: string[];
  expectedSalary?: number;
  currency?: string;
  noticePeriod?: string;
  preferredRoles: string[];
  preferredLocations: string[];
  resumeText?: string;
  assignedRecruiterId?: string;
  experience: { title: string; company: string; description?: string }[];
  education: { institution: string; degree?: string; field?: string }[];
  status: string;
  aiProfile?: {
    headline?: string;
    overview?: string;
    careerLevel?: string;
    primarySkills?: string[];
    bestFitRoles?: string[];
    strengths?: string[];
    potentialGaps?: string[];
  };
}

interface AutoApplyProfileData {
  enabled: boolean;
  boards: string[];
  keywords: string[];
  excludeKeywords: string[];
  locations: string[];
  dailyApplyLimit: number;
  mode: "AUTO" | "REVIEW_FIRST";
  requireCoverLetter: boolean;
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

const EMPTY_PROFILE: AutoApplyProfileData = {
  enabled: false,
  boards: [],
  keywords: [],
  excludeKeywords: [],
  locations: [],
  dailyApplyLimit: 10,
  mode: "REVIEW_FIRST",
  requireCoverLetter: true,
};

export default function CandidateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);

  const [profile, setProfile] = useState<AutoApplyProfileData>(EMPTY_PROFILE);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<string | null>(null);

  const [grantingAccess, setGrantingAccess] = useState(false);
  const [portalCreds, setPortalCreds] = useState<{ email: string; tempPassword: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [candidateRes, profileRes] = await Promise.all([
      fetch(`/api/candidates/${id}`),
      fetch(`/api/candidates/${id}/auto-apply-profile`),
    ]);
    const candidateData = await candidateRes.json();
    const profileData = await profileRes.json();
    setCandidate(candidateData.candidate ?? null);
    if (profileData.profile) {
      setProfileId(profileData.profile._id);
      setProfile({
        enabled: profileData.profile.enabled,
        boards: profileData.profile.boards ?? [],
        keywords: profileData.profile.keywords ?? [],
        excludeKeywords: profileData.profile.excludeKeywords ?? [],
        locations: profileData.profile.locations ?? [],
        dailyApplyLimit: profileData.profile.dailyApplyLimit ?? 10,
        mode: profileData.profile.mode ?? "REVIEW_FIRST",
        requireCoverLetter: profileData.profile.requireCoverLetter ?? true,
      });
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      await fetch(`/api/candidates/${id}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await load();
    } finally {
      setAnalyzing(false);
    }
  }

  function startEdit() {
    if (!candidate) return;
    setEditForm({
      email: candidate.email ?? "",
      phone: candidate.phone ?? "",
      location: candidate.location ?? "",
      skills: joinList(candidate.skills),
      expectedSalary: candidate.expectedSalary != null ? String(candidate.expectedSalary) : "",
      currency: candidate.currency ?? "",
      noticePeriod: candidate.noticePeriod ?? "",
      preferredRoles: joinList(candidate.preferredRoles),
      preferredLocations: joinList(candidate.preferredLocations),
    });
    setEditing(true);
  }

  async function saveEdit() {
    setSavingEdit(true);
    try {
      await fetch(`/api/candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: editForm.email || undefined,
          phone: editForm.phone || undefined,
          location: editForm.location || undefined,
          skills: splitList(editForm.skills),
          expectedSalary: editForm.expectedSalary ? Number(editForm.expectedSalary) : undefined,
          currency: editForm.currency || undefined,
          noticePeriod: editForm.noticePeriod || undefined,
          preferredRoles: splitList(editForm.preferredRoles),
          preferredLocations: splitList(editForm.preferredLocations),
        }),
      });
      setEditing(false);
      await load();
    } finally {
      setSavingEdit(false);
    }
  }

  function toggleBoard(board: string) {
    setProfile((p) => ({
      ...p,
      boards: p.boards.includes(board) ? p.boards.filter((b) => b !== board) : [...p.boards, board],
    }));
  }

  async function saveProfile() {
    setSavingProfile(true);
    setIngestMessage(null);
    try {
      const res = await fetch(`/api/candidates/${id}/auto-apply-profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = await res.json();
      setProfileId(data.profile?._id ?? null);
    } finally {
      setSavingProfile(false);
    }
  }

  async function runIngestionNow() {
    if (!profileId) {
      setIngestMessage("Save the auto-apply profile first.");
      return;
    }
    setIngesting(true);
    setIngestMessage(null);
    try {
      const res = await fetch("/api/auto-apply/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      const data = await res.json();
      setIngestMessage(res.ok ? `Queued (job ${data.jobId}). Check /applications shortly.` : (data.error ?? "Failed to queue ingestion"));
    } finally {
      setIngesting(false);
    }
  }

  async function grantPortalAccess() {
    setGrantingAccess(true);
    setPortalCreds(null);
    try {
      const res = await fetch(`/api/candidates/${id}/portal-access`, { method: "POST" });
      const data = await res.json();
      if (res.ok) setPortalCreds({ email: data.email, tempPassword: data.tempPassword });
      else alert(data.error ?? "Failed to grant portal access");
    } finally {
      setGrantingAccess(false);
    }
  }

  if (loading) return <Skeleton className="h-96 w-full max-w-4xl" />;
  if (!candidate) return <p className="text-sm text-slate-500">Candidate not found.</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{candidate.name}</h1>
          <p className="text-sm text-slate-500">
            {candidate.email} {candidate.location && `· ${candidate.location}`} {candidate.phone && `· ${candidate.phone}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href={`/applications?candidateId=${id}`}>View Applications</Link>
          </Button>
          <Button variant="secondary" onClick={editing ? () => setEditing(false) : startEdit}>
            {editing ? "Cancel" : "Edit Details"}
          </Button>
          <Button variant="secondary" onClick={grantPortalAccess} disabled={grantingAccess || !candidate.email}>
            {grantingAccess ? "Granting…" : "Grant Portal Access"}
          </Button>
          <Button onClick={handleAnalyze} disabled={analyzing}>
            <Sparkles className={analyzing ? "animate-pulse" : ""} />
            {analyzing ? "Analyzing…" : candidate.aiProfile ? "Re-analyze with AI" : "Analyze with AI"}
          </Button>
        </div>
      </div>

      {portalCreds && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardHeader>
            <CardTitle className="text-emerald-800">Portal Access Granted</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-emerald-800">
            <p>
              Share these login details with the candidate — this password is shown only once and cannot be retrieved again (running this again generates a
              new one).
            </p>
            <p className="mt-2 font-mono text-xs">
              Email: {portalCreds.email}
              <br />
              Temp password: {portalCreds.tempPassword}
            </p>
          </CardContent>
        </Card>
      )}

      {editing && (
        <Card>
          <CardHeader>
            <CardTitle>Edit Candidate Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
                <Input value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Phone</label>
                <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Location</label>
              <Input value={editForm.location} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Skills (comma-separated)</label>
              <Input value={editForm.skills} onChange={(e) => setEditForm((f) => ({ ...f, skills: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Expected Salary</label>
                <Input type="number" value={editForm.expectedSalary} onChange={(e) => setEditForm((f) => ({ ...f, expectedSalary: e.target.value }))} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Currency</label>
                <Input value={editForm.currency} onChange={(e) => setEditForm((f) => ({ ...f, currency: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Notice Period</label>
              <Input value={editForm.noticePeriod} onChange={(e) => setEditForm((f) => ({ ...f, noticePeriod: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Preferred Roles (comma-separated)</label>
              <Input value={editForm.preferredRoles} onChange={(e) => setEditForm((f) => ({ ...f, preferredRoles: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Preferred Locations (comma-separated)</label>
              <Input value={editForm.preferredLocations} onChange={(e) => setEditForm((f) => ({ ...f, preferredLocations: e.target.value }))} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={saveEdit} disabled={savingEdit}>
                {savingEdit ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {candidate.aiProfile && (
        <Card>
          <CardHeader>
            <CardTitle>Candidate Intelligence</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <div className="text-base font-medium text-slate-900">{candidate.aiProfile.headline}</div>
              <p className="mt-1 text-sm text-slate-600">{candidate.aiProfile.overview}</p>
            </div>
            {!!candidate.aiProfile.bestFitRoles?.length && (
              <div>
                <div className="text-xs font-medium text-slate-500">Best-fit roles</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {candidate.aiProfile.bestFitRoles.map((r) => (
                    <Badge key={r} variant="info">
                      {r}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {!!candidate.aiProfile.strengths?.length && (
                <div>
                  <div className="text-xs font-medium text-slate-500">Strengths</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-slate-700">
                    {candidate.aiProfile.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!!candidate.aiProfile.potentialGaps?.length && (
                <div>
                  <div className="text-xs font-medium text-slate-500">Potential gaps</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-slate-700">
                    {candidate.aiProfile.potentialGaps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {candidate.skills.map((s) => (
            <Badge key={s} variant="secondary">
              {s}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Experience</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {candidate.experience.map((e, i) => (
            <div key={i}>
              <div className="text-sm font-medium text-slate-900">
                {e.title} · {e.company}
              </div>
              {e.description && <p className="text-xs text-slate-500">{e.description}</p>}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Education</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {candidate.education.map((e, i) => (
            <div key={i} className="text-sm text-slate-700">
              {e.degree} {e.field} — {e.institution}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-Apply Settings</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={profile.enabled} onChange={(e) => setProfile((p) => ({ ...p, enabled: e.target.checked }))} />
            Enable auto-apply for this candidate
          </label>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Keywords (comma-separated — used as the job search query)</label>
            <Input
              value={joinList(profile.keywords)}
              onChange={(e) => setProfile((p) => ({ ...p, keywords: splitList(e.target.value) }))}
              placeholder="senior react developer"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Exclude keywords (comma-separated)</label>
            <Input value={joinList(profile.excludeKeywords)} onChange={(e) => setProfile((p) => ({ ...p, excludeKeywords: splitList(e.target.value) }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Locations (comma-separated)</label>
            <Input value={joinList(profile.locations)} onChange={(e) => setProfile((p) => ({ ...p, locations: splitList(e.target.value) }))} />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Job boards to search</label>
            <div className="flex flex-wrap gap-3">
              {JOB_BOARDS.map((board) => (
                <label key={board} className="flex items-center gap-1.5 text-xs text-slate-700">
                  <input type="checkbox" checked={profile.boards.includes(board)} onChange={() => toggleBoard(board)} />
                  {board}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Daily apply limit</label>
              <Input
                type="number"
                value={profile.dailyApplyLimit}
                onChange={(e) => setProfile((p) => ({ ...p, dailyApplyLimit: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Mode</label>
              <select
                className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm"
                value={profile.mode}
                onChange={(e) => setProfile((p) => ({ ...p, mode: e.target.value as "AUTO" | "REVIEW_FIRST" }))}
              >
                <option value="REVIEW_FIRST">Review first (recruiter approves)</option>
                <option value="AUTO">Fully automatic</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2">
            <div className="flex gap-2">
              <Button onClick={saveProfile} disabled={savingProfile}>
                {savingProfile ? "Saving…" : "Save Auto-Apply Settings"}
              </Button>
              <Button variant="secondary" onClick={runIngestionNow} disabled={ingesting || !profileId}>
                {ingesting ? "Queuing…" : "Run Ingestion Now"}
              </Button>
            </div>
          </div>
          {ingestMessage && <p className="text-xs text-slate-500">{ingestMessage}</p>}
          {!candidate.resumeText && profile.enabled && (
            <p className="text-xs text-amber-600">Note: this candidate has no resume text on file — tailoring will fail without one. Upload a resume first.</p>
          )}
          {!candidate.assignedRecruiterId && (
            <p className="text-xs text-amber-600">Note: ingestion silently skips candidates with no assigned recruiter.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
