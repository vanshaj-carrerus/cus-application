/** Types and pure helpers shared by the background worker and the LinkedIn content script. */

export interface ApplyPlanData {
  /** Each search carries the looser searches to try, in order, when it finds nothing. */
  searches: Array<{ keywords: string; location: string; dateLevel?: number; fallbacks?: Array<{ keywords: string; location: string; dateLevel?: number }> }>;
  remaining: number;
  excludeKeywords: string[];
  candidate: { name: string; email?: string; phone?: string; location?: string; linkedinUrl?: string; portfolioUrl?: string; githubUrl?: string };
  appliedIds: string[];
  /** Applications one run sends before it finishes. */
  runTarget?: number;
  /** Applications started but not finished earlier; done before any new search. */
  retryJobs?: JobCard[];
}

export interface JobCard {
  id: string;
  title: string;
  company?: string;
  location?: string;
  url?: string;
  /** The search card says "Easy Apply" (the short kind). The long ones, on the company's own site, are done first. */
  easy?: boolean;
}

export type ApplyOutcome = "APPLIED" | "SKIPPED" | "FAILED";

/** The job portals a Start run can work on. */
export type ApplyPortal = "LINKEDIN" | "GLASSDOOR" | "INDEED" | "ZIPRECRUITER" | "NAUKRI";
export const APPLY_PORTALS: ApplyPortal[] = ["LINKEDIN", "GLASSDOOR", "INDEED", "ZIPRECRUITER", "NAUKRI"];

/** The portal's own pages (as opposed to an employer's site the Apply button leads to). */
export const isPortalHost = (hostname: string) => /(^|\.)(linkedin\.com|glassdoor\.[a-z.]+|indeed\.[a-z.]+|ziprecruiter\.[a-z.]+|naukri\.com)$/i.test(hostname);
export const isLinkedInHost = (hostname: string) => /(^|\.)linkedin\.com$/i.test(hostname);
export const isIndeedHost = (hostname: string) => /(^|\.)indeed\.[a-z.]+$/i.test(hostname);
export const isZipRecruiterHost = (hostname: string) => /(^|\.)ziprecruiter\.[a-z.]+$/i.test(hostname);
export const isNaukriHost = (hostname: string) => /(^|\.)naukri\.com$/i.test(hostname);
export const isGlassdoorHost = (hostname: string) => /(^|\.)glassdoor\.[a-z.]+$/i.test(hostname);

/** Pause between one application and the next. */
export const PACE_MS = { first: 1_500, gap: 3_000 };
export const MAX_JOBS_PER_SEARCH = 25;

/** Shown in the on-page status box and the portal card so you can tell which build of the extension is running (also the version at chrome://extensions). */
export const ASSIST_VERSION = "1.11.0";
