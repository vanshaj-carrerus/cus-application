/**
 * What the extension reads out of a candidate's own LinkedIn session. Shapes are deliberately loose (strings and
 * short lists): LinkedIn's pages change, so we keep what is visible rather than model its internals.
 * `clean*` run on the server over whatever the extension posts, so the stored data is bounded and typed.
 */

export const LINKEDIN_SECTIONS = ["profile", "messages", "jobs"] as const;
export type LinkedInSection = (typeof LINKEDIN_SECTIONS)[number];

export interface LinkedInEntry {
  /** First visible line (job title / school / skill name). */
  title: string;
  /** Second line (company / degree). */
  subtitle?: string;
  /** Third line (date range). */
  meta?: string;
  /** Remaining lines. */
  details?: string[];
}

export interface LinkedInProfile {
  url: string;
  name: string;
  headline?: string;
  location?: string;
  about?: string;
  experience: LinkedInEntry[];
  education: LinkedInEntry[];
  skills: string[];
}

export interface LinkedInMessage {
  sender: string;
  text: string;
  time?: string;
}

export interface LinkedInThread {
  with: string;
  snippet?: string;
  time?: string;
  messages: LinkedInMessage[];
}

export interface LinkedInJob {
  jobId?: string;
  title: string;
  company?: string;
  location?: string;
  url?: string;
  /** Where it was found: saved list or applied list. */
  list: "SAVED" | "APPLIED";
  note?: string;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const opt = (v: unknown, max: number): string | undefined => str(v, max) || undefined;
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

function cleanEntry(v: unknown): LinkedInEntry | null {
  const e = (v ?? {}) as Record<string, unknown>;
  const title = str(e.title, 300);
  if (!title) return null;
  const details = arr(e.details, 10).map((d) => str(d, 1500)).filter(Boolean);
  return { title, subtitle: opt(e.subtitle, 300), meta: opt(e.meta, 200), details: details.length ? details : undefined };
}

function cleanLinkedInUrl(v: unknown): string {
  const url = str(v, 500);
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/.test(u.hostname) ? `${u.origin}${u.pathname}` : "";
  } catch {
    return "";
  }
}

/** `/in/jane-doe/` -> `jane-doe`, for comparing the account in the browser with the one the recruiter saved. */
export function linkedInSlug(url: string | undefined): string {
  const m = (url ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

export function cleanProfile(v: unknown): LinkedInProfile | null {
  const p = (v ?? {}) as Record<string, unknown>;
  const name = str(p.name, 200);
  const url = cleanLinkedInUrl(p.url);
  if (!name || !url) return null;
  return {
    url,
    name,
    headline: opt(p.headline, 400),
    location: opt(p.location, 200),
    about: opt(p.about, 4000),
    experience: arr(p.experience, 50).map(cleanEntry).filter((e): e is LinkedInEntry => !!e),
    education: arr(p.education, 20).map(cleanEntry).filter((e): e is LinkedInEntry => !!e),
    skills: arr(p.skills, 100).map((s) => str(s, 100)).filter(Boolean),
  };
}

export function cleanThreads(v: unknown): LinkedInThread[] {
  const threads: LinkedInThread[] = [];
  for (const t of arr(v, 30)) {
    const x = (t ?? {}) as Record<string, unknown>;
    const who = str(x.with, 200);
    if (!who) continue;
    const messages: LinkedInMessage[] = [];
    for (const m of arr(x.messages, 100)) {
      const y = (m ?? {}) as Record<string, unknown>;
      const text = str(y.text, 4000);
      if (text) messages.push({ sender: str(y.sender, 200), text, time: opt(y.time, 100) });
    }
    threads.push({ with: who, snippet: opt(x.snippet, 500), time: opt(x.time, 100), messages });
  }
  return threads;
}

export function cleanJobs(v: unknown): LinkedInJob[] {
  const jobs: LinkedInJob[] = [];
  for (const j of arr(v, 200)) {
    const x = (j ?? {}) as Record<string, unknown>;
    const title = str(x.title, 300);
    if (!title) continue;
    jobs.push({
      jobId: opt(x.jobId, 40),
      title,
      company: opt(x.company, 200),
      location: opt(x.location, 200),
      url: cleanLinkedInUrl(x.url) || undefined,
      list: x.list === "APPLIED" ? "APPLIED" : "SAVED",
      note: opt(x.note, 300),
    });
  }
  return jobs;
}
