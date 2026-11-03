"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { JOB_BOARDS } from "@/lib/models/enums";
import { ApplicationDetailsCard } from "@/components/shared/application-details-card";
import { SavedAnswersPanel } from "@/components/shared/saved-answers-panel";
import { CandidateApplyPanel } from "@/components/shared/candidate-apply-panel";

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
  experience: ExperienceRow[];
  education: EducationRow[];
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

interface ExperienceRow {
  title: string;
  company: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  description?: string;
}

interface EducationRow {
  institution: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
}

const BLANK_EXPERIENCE: ExperienceRow = { title: "", company: "", startDate: "", endDate: "", isCurrent: false, description: "" };
const BLANK_EDUCATION: EducationRow = { institution: "", degree: "", field: "", startDate: "", endDate: "" };

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
  const router = useRouter();
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editExperience, setEditExperience] = useState<ExperienceRow[]>([]);
  const [editEducation, setEditEducation] = useState<EducationRow[]>([]);

  const [profile, setProfile] = useState<AutoApplyProfileData>(EMPTY_PROFILE);
  const [profileId, setProfileId] = useState<string | null>(null);
  // The comma-separated fields are edited as raw text and only split into lists on save. Deriving the
  // input's value from the parsed list on every keystroke strips the trailing comma/space you just typed.
  const [listText, setListText] = useState({ keywords: "", excludeKeywords: "", locations: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<string | null>(null);

  const [grantingAccess, setGrantingAccess] = useState(false);
  const [portalCreds, setPortalCreds] = useState<{ loginId: string; password: string } | null>(null);
  const [showPortalPanel, setShowPortalPanel] = useState(false);
  const [showPortalForm, setShowPortalForm] = useState(false);
  const [portalForm, setPortalForm] = useState({ loginId: "", password: "" });
  const [portalError, setPortalError] = useState<string | null>(null);
  const [portalStatus, setPortalStatus] = useState<{
    exists: boolean;
    loginId?: string;
    isActive?: boolean;
    lastLoginAt?: string;
    createdAt?: string;
  } | null>(null);
  const [loadingPortalStatus, setLoadingPortalStatus] = useState(false);

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
      setListText({
        keywords: joinList(profileData.profile.keywords),
        excludeKeywords: joinList(profileData.profile.excludeKeywords),
        locations: joinList(profileData.profile.locations),
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
    setEditExperience(candidate.experience.map((e) => ({ ...BLANK_EXPERIENCE, ...e })));
    setEditEducation(candidate.education.map((e) => ({ ...BLANK_EDUCATION, ...e })));
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
          // Rows left blank are dropped; a current job has no end date.
          experience: editExperience
            .filter((e) => e.title?.trim() || e.company?.trim())
            .map((e) => ({ ...e, title: e.title.trim(), company: e.company.trim(), endDate: e.isCurrent ? "" : e.endDate })),
          education: editEducation.filter((e) => e.institution?.trim()).map((e) => ({ ...e, institution: e.institution.trim() })),
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
        body: JSON.stringify({
          ...profile,
          keywords: splitList(listText.keywords),
          excludeKeywords: splitList(listText.excludeKeywords),
          locations: splitList(listText.locations),
        }),
      });
      const data = await res.json();
      setProfileId(data.profile?._id ?? null);
      if (data.profile) {
        // Show the list as it was actually saved (trimmed, empty entries dropped).
        setProfile((p) => ({ ...p, keywords: data.profile.keywords ?? [], excludeKeywords: data.profile.excludeKeywords ?? [], locations: data.profile.locations ?? [] }));
        setListText({
          keywords: joinList(data.profile.keywords),
          excludeKeywords: joinList(data.profile.excludeKeywords),
          locations: joinList(data.profile.locations),
        });
      }
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
      setIngestMessage(res.ok ? `Done: ${data.applicationsCreated} new job(s), ${data.prepared} ready to apply${data.failed ? `, ${data.failed} need a retry` : ""}. Open the Apply queue.` : (data.error ?? "Run failed"));
    } finally {
      setIngesting(false);
    }
  }

  async function handleDelete() {
    if (
      !confirm(
        "Delete this candidate? This also deletes their applications, resumes, auto-apply profile, and portal login. This cannot be undone."
      )
    )
      return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/candidates/${id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/candidates");
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to delete candidate");
      }
    } finally {
      setDeleting(false);
    }
  }

  async function openPortalPanel() {
    setPortalForm({ loginId: candidate?.email ?? "", password: "" });
    setPortalError(null);
    setPortalCreds(null);
    setShowPortalPanel(true);
    setLoadingPortalStatus(true);
    try {
      const res = await fetch(`/api/candidates/${id}/portal-access`);
      const data = await res.json();
      setPortalStatus(data);
      setShowPortalForm(!data.exists);
    } finally {
      setLoadingPortalStatus(false);
    }
  }

  async function grantPortalAccess(e: React.FormEvent) {
    e.preventDefault();
    setGrantingAccess(true);
    setPortalError(null);
    try {
      const res = await fetch(`/api/candidates/${id}/portal-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: portalForm.loginId || undefined, password: portalForm.password || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setPortalCreds({ loginId: data.loginId, password: data.password });
        setShowPortalForm(false);
        setPortalStatus({ exists: true, loginId: data.loginId, isActive: true });
      } else {
        setPortalError(data.error ?? "Failed to grant portal access");
      }
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
          <Button asChild>
            <Link href={`/apply-queue?candidateId=${id}`}>Apply queue</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href={`/applications?candidateId=${id}`}>View Applications</Link>
          </Button>
          <Button variant="secondary" onClick={editing ? () => setEditing(false) : startEdit}>
            {editing ? "Cancel" : "Edit Details"}
          </Button>
          <Button variant="secondary" onClick={showPortalPanel ? () => setShowPortalPanel(false) : openPortalPanel}>
            {showPortalPanel ? "Cancel" : "Grant Portal Access"}
          </Button>
          <Button onClick={handleAnalyze} disabled={analyzing}>
            <Sparkles className={analyzing ? "animate-pulse" : ""} />
            {analyzing ? "Analyzing…" : candidate.aiProfile ? "Re-analyze with AI" : "Analyze with AI"}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            <Trash2 />
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>

      <CandidateApplyPanel candidateId={id} />

      {showPortalPanel && (
        <Card>
          <CardHeader>
            <CardTitle>Portal Access</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {loadingPortalStatus && <p className="text-sm text-slate-500">Checking current access…</p>}

            {!loadingPortalStatus && portalStatus?.exists && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Portal access already set up</p>
                <p className="mt-1 text-xs text-slate-500">
                  Login ID: <span className="font-mono">{portalStatus.loginId}</span>
                  {" · "}
                  {portalStatus.isActive ? "Active" : "Inactive"}
                  {portalStatus.lastLoginAt && <> · Last login {new Date(portalStatus.lastLoginAt).toLocaleString()}</>}
                  {!portalStatus.lastLoginAt && " · Never logged in yet"}
                </p>
                <p className="mt-2 text-xs text-slate-400">
                  The password can&apos;t be retrieved — it&apos;s stored hashed. Reset it below only if the candidate needs a new one.
                </p>
                {!showPortalForm && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => setShowPortalForm(true)}>
                    Reset / Create New Credentials
                  </Button>
                )}
              </div>
            )}

            {!loadingPortalStatus && portalStatus && !portalStatus.exists && (
              <p className="text-sm text-slate-500">No portal access set up yet for this candidate. Create credentials below.</p>
            )}

            {!loadingPortalStatus && showPortalForm && (
              <form onSubmit={grantPortalAccess} className="flex flex-col gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Login ID (email)</label>
                  <Input
                    value={portalForm.loginId}
                    onChange={(e) => setPortalForm((f) => ({ ...f, loginId: e.target.value }))}
                    placeholder={candidate.email || "candidate@example.com"}
                  />
                  <p className="mt-1 text-xs text-slate-400">Leave blank to use the candidate&apos;s on-file email ({candidate.email || "none set"}).</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Password</label>
                  <Input
                    type="text"
                    value={portalForm.password}
                    onChange={(e) => setPortalForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="Leave blank to auto-generate"
                  />
                  <p className="mt-1 text-xs text-slate-400">At least 8 characters if set. Shown in plain text here so you can set something memorable.</p>
                </div>
                {portalError && <p className="text-xs text-red-600">{portalError}</p>}
                <div className="flex justify-end gap-2">
                  {portalStatus?.exists && (
                    <Button type="button" variant="secondary" onClick={() => setShowPortalForm(false)}>
                      Cancel
                    </Button>
                  )}
                  <Button type="submit" disabled={grantingAccess}>
                    {grantingAccess ? "Saving…" : portalStatus?.exists ? "Reset Credentials" : "Grant Access"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {portalCreds && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardHeader>
            <CardTitle className="text-emerald-800">Portal Access Granted</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-emerald-800">
            <p>Share these login details with the candidate — the password is shown only once and cannot be retrieved again (granting access again sets a new one).</p>
            <p className="mt-2 font-mono text-xs">
              Login ID: {portalCreds.loginId}
              <br />
              Password: {portalCreds.password}
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
            <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-900">Experience</div>
                <Button type="button" variant="secondary" size="sm" onClick={() => setEditExperience((list) => [...list, { ...BLANK_EXPERIENCE }])}>
                  + Add experience
                </Button>
              </div>
              {editExperience.length === 0 && <p className="text-xs text-slate-500">No experience yet.</p>}
              {editExperience.map((row, i) => {
                const set = (patch: Partial<ExperienceRow>) => setEditExperience((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
                return (
                  <div key={i} className="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Input placeholder="Job title" value={row.title} onChange={(e) => set({ title: e.target.value })} />
                      <Input placeholder="Company" value={row.company} onChange={(e) => set({ company: e.target.value })} />
                      <Input placeholder="Start (e.g. Jan 2021)" value={row.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value })} />
                      <Input placeholder="End (e.g. Mar 2024)" value={row.isCurrent ? "" : (row.endDate ?? "")} disabled={row.isCurrent} onChange={(e) => set({ endDate: e.target.value })} />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={!!row.isCurrent} onChange={(e) => set({ isCurrent: e.target.checked })} />
                      I currently work here
                    </label>
                    <textarea
                      className="min-h-20 rounded-md border border-slate-200 px-3 py-2 text-sm"
                      placeholder="What they did there (responsibilities, achievements)"
                      value={row.description ?? ""}
                      onChange={(e) => set({ description: e.target.value })}
                    />
                    <div className="flex justify-end">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditExperience((list) => list.filter((_, j) => j !== i))}>
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-900">Education</div>
                <Button type="button" variant="secondary" size="sm" onClick={() => setEditEducation((list) => [...list, { ...BLANK_EDUCATION }])}>
                  + Add education
                </Button>
              </div>
              {editEducation.length === 0 && <p className="text-xs text-slate-500">No education yet.</p>}
              {editEducation.map((row, i) => {
                const set = (patch: Partial<EducationRow>) => setEditEducation((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
                return (
                  <div key={i} className="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Input className="col-span-2" placeholder="School / university" value={row.institution} onChange={(e) => set({ institution: e.target.value })} />
                      <Input placeholder="Degree (e.g. B.Tech)" value={row.degree ?? ""} onChange={(e) => set({ degree: e.target.value })} />
                      <Input placeholder="Field of study" value={row.field ?? ""} onChange={(e) => set({ field: e.target.value })} />
                      <Input placeholder="Start (e.g. 2017)" value={row.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value })} />
                      <Input placeholder="End (e.g. 2021)" value={row.endDate ?? ""} onChange={(e) => set({ endDate: e.target.value })} />
                    </div>
                    <div className="flex justify-end">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditEducation((list) => list.filter((_, j) => j !== i))}>
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
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
          {candidate.experience.length === 0 && <p className="text-sm text-slate-500">None yet. Use Edit Details to add experience.</p>}
          {candidate.experience.map((e, i) => (
            <div key={i}>
              <div className="text-sm font-medium text-slate-900">
                {e.title} · {e.company}
                {(e.startDate || e.endDate || e.isCurrent) && (
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {e.startDate} – {e.isCurrent ? "Present" : e.endDate}
                  </span>
                )}
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
          {candidate.education.length === 0 && <p className="text-sm text-slate-500">None yet. Use Edit Details to add education.</p>}
          {candidate.education.map((e, i) => (
            <div key={i} className="text-sm text-slate-700">
              {e.degree} {e.field} — {e.institution}
              {(e.startDate || e.endDate) && (
                <span className="ml-2 text-xs text-slate-500">
                  {e.startDate} – {e.endDate}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <ApplicationDetailsCard endpoint={`/api/candidates/${id}`} audience="staff" />

      <SavedAnswersPanel baseUrl={`/api/candidates/${id}/answers`} audience="staff" />

      <Card>
        <CardHeader>
          <CardTitle>Saved search (optional, for repeat runs)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={profile.enabled} onChange={(e) => setProfile((p) => ({ ...p, enabled: e.target.checked }))} />
            Enable auto-apply for this candidate
          </label>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Keywords (comma-separated — used as the job search query)</label>
            <Input
              value={listText.keywords}
              onChange={(e) => setListText((t) => ({ ...t, keywords: e.target.value }))}
              placeholder="senior react developer"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Exclude keywords (comma-separated)</label>
            <Input value={listText.excludeKeywords} onChange={(e) => setListText((t) => ({ ...t, excludeKeywords: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Locations (comma-separated)</label>
            <Input value={listText.locations} onChange={(e) => setListText((t) => ({ ...t, locations: e.target.value }))} />
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
                {ingesting ? "Finding jobs and preparing documents…" : "Run Ingestion Now"}
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
