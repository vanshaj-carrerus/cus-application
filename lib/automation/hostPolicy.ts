/**
 * Classifies a job's apply address by kind of site. A person now does the clicking, so this no longer decides
 * what the bot may attempt; it only tells the apply queue what a marketer is about to open (and drives the ATS
 * adapters and the job ingestion preference for direct employer/ATS links).
 *
 *   ATS         Greenhouse, Lever, Ashby, Workday, ... standard forms built for applying.
 *   EMPLOYER    A company's own careers page (usually an ATS underneath).
 *   AGGREGATOR  Jooble, Jobrapido, SimplyHired... they only redirect to the real posting.
 *   BOARD       Naukri, Shine, Foundit... job boards with their own login.
 *   SESSION     LinkedIn, Indeed, Glassdoor, Monster, Dice, ZipRecruiter: need the candidate's signed-in account.
 */

export type HostClass = "ATS" | "EMPLOYER" | "AGGREGATOR" | "BOARD" | "SESSION";
export type AtsId = "GREENHOUSE" | "LEVER" | "WORKDAY" | "ASHBY" | "WORKABLE" | "SMARTRECRUITERS" | "ICIMS" | "JOBVITE" | "BAMBOOHR" | "RECRUITEE" | "TEAMTAILOR" | "BREEZY" | "TALEO" | "OTHER_ATS";

const ATS_PATTERNS: Array<{ id: AtsId; test: RegExp }> = [
  { id: "GREENHOUSE", test: /(^|\.)greenhouse\.io$/ },
  { id: "LEVER", test: /(^|\.)lever\.co$/ },
  { id: "WORKDAY", test: /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/ },
  { id: "ASHBY", test: /(^|\.)ashbyhq\.com$/ },
  { id: "WORKABLE", test: /(^|\.)workable\.com$/ },
  { id: "SMARTRECRUITERS", test: /(^|\.)smartrecruiters\.com$/ },
  { id: "ICIMS", test: /(^|\.)icims\.com$/ },
  { id: "JOBVITE", test: /(^|\.)jobvite\.com$/ },
  { id: "BAMBOOHR", test: /(^|\.)bamboohr\.com$/ },
  { id: "RECRUITEE", test: /(^|\.)recruitee\.com$/ },
  { id: "TEAMTAILOR", test: /(^|\.)teamtailor\.com$/ },
  { id: "BREEZY", test: /(^|\.)breezy\.hr$/ },
  { id: "TALEO", test: /(^|\.)taleo\.net$/ },
  { id: "OTHER_ATS", test: /(^|\.)(rippling|pinpointhq|personio|jazzhr|applytojob|paylocity|ultipro|dayforcehcm|adp|successfactors|oraclecloud)\.(com|de)$/ },
];

const SESSION_BOARDS: Array<{ board: "LINKEDIN" | "INDEED" | "GLASSDOOR" | "MONSTER" | "DICE" | "ZIPRECRUITER"; test: RegExp }> = [
  { board: "LINKEDIN", test: /(^|\.)linkedin\.com$/ },
  { board: "INDEED", test: /(^|\.)indeed\.[a-z.]+$/ },
  { board: "GLASSDOOR", test: /(^|\.)glassdoor\.[a-z.]+$/ },
  { board: "MONSTER", test: /(^|\.)monster\.[a-z.]+$/ },
  { board: "DICE", test: /(^|\.)dice\.com$/ },
  { board: "ZIPRECRUITER", test: /(^|\.)ziprecruiter\.[a-z.]+$/ },
];

const AGGREGATORS = /(^|\.)(jooble|jobrapido|simplyhired|adzuna|talent|jobtome|kitjob|neuvoo|learn4good|careerjet|jobisjob|trovit|recruit\.net|whatjobs|jobs2careers|snagajob)\.[a-z.]+$/;
const BOARDS = /(^|\.)(naukri|shine|foundit|monsterindia|timesjobs|instahyre|wellfound|angel|hirist|cutshort|apna|internshala|freshersworld)\.[a-z.]+$/;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface HostInfo {
  host: string;
  hostClass: HostClass;
  ats?: AtsId;
  sessionBoard?: (typeof SESSION_BOARDS)[number]["board"];
}

export function classifyHost(url: string): HostInfo {
  const host = hostOf(url);
  const ats = ATS_PATTERNS.find((p) => p.test.test(host));
  if (ats) return { host, hostClass: "ATS", ats: ats.id };
  const session = SESSION_BOARDS.find((b) => b.test.test(host));
  if (session) return { host, hostClass: "SESSION", sessionBoard: session.board };
  if (AGGREGATORS.test(host)) return { host, hostClass: "AGGREGATOR" };
  if (BOARDS.test(host)) return { host, hostClass: "BOARD" };
  return { host, hostClass: "EMPLOYER" };
}

/** True when the URL is on a recognised ATS (used by ingestion to prefer such links). */
export const isAtsUrl = (url: string): boolean => classifyHost(url).hostClass === "ATS";
/** True for sites that only list jobs and redirect elsewhere, or that need a signed-in session. */
export const isBoardOrAggregatorUrl = (url: string): boolean => ["AGGREGATOR", "BOARD", "SESSION"].includes(classifyHost(url).hostClass);
