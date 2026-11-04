import type { ApplyPortal } from "../linkedin-shared";

/**
 * The pages each portal's run goes to. One entry per portal, so one portal's address scheme can never leak into another's.
 * (No page code in here: the background worker uses this file.)
 */
interface PortalUrls {
  /** Every kind of job (quick apply and "apply on the company website"), newest first, posted within the last week. */
  search: (s: Spec) => string;
  job: (job: { id: string; url?: string }) => string;
}

const enc = encodeURIComponent;

type Spec = { keywords: string; location: string; dateLevel?: number };
/** The posted-within filter for a search at a date level (0 the normal window, then older, 3 and up: any date). One list per portal, in that portal's own units. */
const pick = <T,>(level: number | undefined, steps: T[], any: T) => (level ?? 0) >= steps.length ? any : steps[level ?? 0];

const PORTAL_URLS: Record<ApplyPortal, PortalUrls> = {
  LINKEDIN: {
    search: (s) => `https://www.linkedin.com/jobs/search/?keywords=${enc(s.keywords)}${s.location ? `&location=${enc(s.location)}` : ""}${pick(s.dateLevel, ["&f_TPR=r604800", "&f_TPR=r1209600", "&f_TPR=r2592000"], "")}&sortBy=DD`,
    job: (job) => `https://www.linkedin.com/jobs/view/${job.id}/`,
  },
  NAUKRI: {
    // Naukri's address carries the words in its path (full-stack-developer-jobs-in-pune) and again as k= and l=; "jobAge" is the posted-within filter in days.
    search: (s) => {
      const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const path = `${slug(s.keywords)}-jobs${s.location ? `-in-${slug(s.location.split(",")[0])}` : ""}`;
      return `https://www.naukri.com/${path}?k=${enc(s.keywords)}${s.location ? `&l=${enc(s.location.split(",")[0])}` : ""}${pick(s.dateLevel, ["&jobAge=7", "&jobAge=15", "&jobAge=30"], "")}`;
    },
    // The link the search card had; Naukri accepts the job's number in a /job-listings- address as a fallback.
    job: (job) => (job.url && /^https?:/i.test(job.url) ? job.url : `https://www.naukri.com/job-listings-${job.id}`),
  },
  ZIPRECRUITER: {
    search: (s) => `https://www.ziprecruiter.com/jobs-search?search=${enc(s.keywords)}${s.location ? `&location=${enc(s.location)}` : ""}${pick(s.dateLevel, ["&days=5", "&days=10", "&days=30"], "")}`,
    job: (job) => (job.url && /^https?:/i.test(job.url) ? job.url : `https://www.ziprecruiter.com/jobs-search?lvk=${job.id}`),
  },
  INDEED: {
    search: (s) => `https://www.indeed.com/jobs?q=${enc(s.keywords)}${s.location ? `&l=${enc(s.location)}` : ""}${pick(s.dateLevel, ["&fromage=7", "&fromage=14"], "")}&sort=date`,
    // The link the search card had (it keeps the country's own Indeed address); the job's key works on its own as a fallback.
    job: (job) => (job.url && /^https?:/i.test(job.url) ? job.url : `https://www.indeed.com/viewjob?jk=${job.id}`),
  },
  GLASSDOOR: {
    search: (s) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc(s.keywords)}${s.location ? `&locKeyword=${enc(s.location)}&locT=C` : ""}${pick(s.dateLevel, ["&fromAge=7", "&fromAge=14", "&fromAge=30"], "")}&sortBy=date_desc`,
    // The link the search card had; Glassdoor accepts the job's number on its own as a fallback.
    job: (job) => (job.url && /^https?:/i.test(job.url) ? job.url : `https://www.glassdoor.com/job-listing/j.htm?jl=${job.id}`),
  },
};

export const searchUrl = (portal: ApplyPortal, s: Spec) => PORTAL_URLS[portal].search(s);
export const jobUrl = (portal: ApplyPortal, job: { id: string; url?: string }) => PORTAL_URLS[portal].job(job);
