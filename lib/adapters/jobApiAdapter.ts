import { env } from "@/lib/env";
import type { IJob } from "@/lib/models/Job";

/**
 * Adapter around the RapidAPI "JSearch" job listings API.
 * Nothing else in the app should know about JSearch's response shape —
 * everything goes through normalizeJob() into our own Job schema.
 *
 * NOTE: JSearch's search endpoint is /search-v2 (not /search) as of the
 * current API version, and results come back nested under data.jobs rather
 * than data directly. Both were confirmed live against the API before
 * writing this adapter — don't "fix" this back to /search.
 */

export interface JobSearchParams {
  query: string; // e.g. "senior react developer in Ahmedabad"
  page?: number;
  numPages?: number;
  remoteOnly?: boolean;
  employmentTypes?: string[]; // FULLTIME, CONTRACTOR, PARTTIME, INTERN
  datePosted?: "all" | "today" | "3days" | "week" | "month";
}

export interface RawJSearchJob {
  job_id: string;
  employer_name?: string | null;
  employer_logo?: string | null;
  job_title: string;
  job_description: string;
  job_apply_link?: string | null;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_location?: string | null;
  job_is_remote?: boolean;
  job_employment_type?: string | null;
  job_employment_types?: string[] | null;
  job_posted_at_datetime_utc?: string | null;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_period?: string | null;
  job_salary_string?: string | null;
  job_benefits_strings?: string[] | null;
  job_highlights?: {
    Qualifications?: string[];
    Responsibilities?: string[];
    Benefits?: string[];
  } | null;
  job_google_link?: string | null;
}

interface JSearchSearchResponse {
  status: string;
  request_id: string;
  data: { jobs: RawJSearchJob[] };
}

interface JSearchDetailsResponse {
  status: string;
  request_id: string;
  data: RawJSearchJob[];
}

const SOURCE_NAME = "jsearch";

class JobApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function jsearchFetch<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(path, env.jobApiUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    headers: {
      "X-RapidAPI-Key": env.jobApiKey,
      "X-RapidAPI-Host": env.jobApiHost,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new JobApiError(`Job API request failed: ${res.status} ${body.slice(0, 300)}`, res.status);
  }

  return res.json() as Promise<T>;
}

export async function fetchJobs(params: JobSearchParams): Promise<RawJSearchJob[]> {
  const data = await jsearchFetch<JSearchSearchResponse>("/search-v2", {
    query: params.query,
    page: params.page ?? 1,
    num_pages: params.numPages ?? 1,
    date_posted: params.datePosted ?? "all",
    remote_jobs_only: params.remoteOnly,
    employment_types: params.employmentTypes?.join(","),
  });
  return data.data?.jobs ?? [];
}

export async function fetchJob(jobId: string): Promise<RawJSearchJob | null> {
  const data = await jsearchFetch<JSearchDetailsResponse>("/job-details", { job_id: jobId });
  return data.data?.[0] ?? null;
}

export async function searchJobs(naturalLanguageQuery: string): Promise<RawJSearchJob[]> {
  return fetchJobs({ query: naturalLanguageQuery });
}

function inferEmploymentType(raw?: string | null): IJob["employmentType"] {
  switch ((raw || "").toUpperCase()) {
    case "FULLTIME":
    case "FULL_TIME":
      return "FULL_TIME";
    case "PARTTIME":
    case "PART_TIME":
      return "PART_TIME";
    case "CONTRACTOR":
    case "CONTRACT":
      return "CONTRACT";
    case "INTERN":
    case "INTERNSHIP":
      return "INTERNSHIP";
    default:
      return "UNKNOWN";
  }
}

export function normalizeJob(raw: RawJSearchJob): Partial<IJob> {
  return {
    externalJobId: raw.job_id,
    source: SOURCE_NAME,
    sourceUrl: raw.job_google_link ?? undefined,
    applicationUrl: raw.job_apply_link ?? undefined,
    title: raw.job_title,
    company: raw.employer_name || "Unknown",
    description: raw.job_description || "",
    city: raw.job_city ?? undefined,
    state: raw.job_state ?? undefined,
    country: raw.job_country ?? undefined,
    location: raw.job_location || [raw.job_city, raw.job_state, raw.job_country].filter(Boolean).join(", "),
    remoteType: raw.job_is_remote ? "REMOTE" : "ONSITE",
    employmentType: inferEmploymentType(raw.job_employment_type ?? raw.job_employment_types?.[0]),
    // JSearch no longer returns structured required-skills/experience fields —
    // these are left empty at import time and populated by AI job analysis
    // instead of being guessed here (never invent facts at the adapter layer).
    salaryMin: raw.job_min_salary ?? undefined,
    salaryMax: raw.job_max_salary ?? undefined,
    skills: [],
    qualifications: raw.job_highlights?.Qualifications ?? [],
    responsibilities: raw.job_highlights?.Responsibilities ?? [],
    benefits: raw.job_highlights?.Benefits ?? raw.job_benefits_strings ?? [],
    requirements: raw.job_highlights?.Qualifications ?? [],
    postedAt: raw.job_posted_at_datetime_utc ? new Date(raw.job_posted_at_datetime_utc) : undefined,
    status: "ACTIVE",
  };
}

export function validateNormalizedJob(job: Partial<IJob>): string[] {
  const errors: string[] = [];
  if (!job.externalJobId) errors.push("Missing externalJobId");
  if (!job.title) errors.push("Missing title");
  if (!job.company) errors.push("Missing company");
  if (!job.description || job.description.length < 20) errors.push("Description too short");
  return errors;
}

export const JobApiAdapter = {
  fetchJobs,
  fetchJob,
  searchJobs,
  normalizeJob,
  validateNormalizedJob,
  SOURCE_NAME,
};
