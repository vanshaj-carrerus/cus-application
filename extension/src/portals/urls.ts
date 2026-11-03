import type { ApplyPortal } from "../linkedin-shared";

/**
 * The pages each portal's run goes to. One entry per portal, so one portal's address scheme can never leak into another's.
 * (No page code in here: the background worker uses this file.)
 */
interface PortalUrls {
  /** Every kind of job (quick apply and "apply on the company website"), newest first, posted within the last week. */
  search: (s: { keywords: string; location: string }) => string;
  job: (job: { id: string; url?: string }) => string;
}

const enc = encodeURIComponent;

const PORTAL_URLS: Record<ApplyPortal, PortalUrls> = {
  LINKEDIN: {
    search: (s) => `https://www.linkedin.com/jobs/search/?keywords=${enc(s.keywords)}${s.location ? `&location=${enc(s.location)}` : ""}&f_TPR=r604800&sortBy=DD`,
    job: (job) => `https://www.linkedin.com/jobs/view/${job.id}/`,
  },
  GLASSDOOR: {
    search: (s) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc(s.keywords)}${s.location ? `&locKeyword=${enc(s.location)}&locT=C` : ""}&fromAge=7&sortBy=date_desc`,
    // The link the search card had; Glassdoor accepts the job's number on its own as a fallback.
    job: (job) => (job.url && /^https?:/i.test(job.url) ? job.url : `https://www.glassdoor.com/job-listing/j.htm?jl=${job.id}`),
  },
};

export const searchUrl = (portal: ApplyPortal, s: { keywords: string; location: string }) => PORTAL_URLS[portal].search(s);
export const jobUrl = (portal: ApplyPortal, job: { id: string; url?: string }) => PORTAL_URLS[portal].job(job);
