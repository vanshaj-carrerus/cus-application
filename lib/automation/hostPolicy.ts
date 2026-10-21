import { JobBoardCredential } from "@/lib/models/JobBoardCredential";

/**
 * Which sites the bot applies on by itself, and which go straight to a recruiter.
 *
 * Success rates differ enormously by kind of site, so the bot should not spend runs (and the candidate's
 * accounts) on sites where it mostly fails:
 *
 *   ATS         Greenhouse, Lever, Ashby, Workday, ... — standard forms, built for applying. Always attempted.
 *   EMPLOYER    A company's own careers page. Unknown, but usually an ATS underneath. Attempted.
 *   AGGREGATOR  Jooble, Jobrapido, SimplyHired... — they only redirect to the real posting. Attempted.
 *   BOARD       Naukri, Shine, Foundit... — job boards with their own login. Attempted.
 *   SESSION     LinkedIn, Indeed, Glassdoor, Monster, Dice, ZipRecruiter — aggressive bot checks tied to a real
 *               account. Attempted ONLY when the candidate has a saved signed-in session for that board
 *               (see `npm run board-login`); otherwise handed to a recruiter straight away.
 *
 * Overrides, comma-separated host suffixes in the environment:
 *   APPLY_HOST_ALLOW=example.com   always attempt, whatever the class
 *   APPLY_HOST_BLOCK=example.com   never attempt (checked first)
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

const listFromEnv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
const matchesSuffix = (host: string, list: string[]) => list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

export interface PolicyDecision extends HostInfo {
  run: boolean;
  /** Plain-language reason, shown to the recruiter when run is false. */
  reason?: string;
}

export async function decideHostPolicy(candidateId: string, url: string): Promise<PolicyDecision> {
  const info = classifyHost(url);

  if (matchesSuffix(info.host, listFromEnv("APPLY_HOST_BLOCK"))) {
    return { ...info, run: false, reason: `${info.host} is on this system's block list (APPLY_HOST_BLOCK), so it is not applied to automatically` };
  }
  if (matchesSuffix(info.host, listFromEnv("APPLY_HOST_ALLOW"))) return { ...info, run: true };

  if (info.hostClass === "SESSION" && info.sessionBoard) {
    const credential = await JobBoardCredential.findOne({ candidateId, board: info.sessionBoard, status: "ACTIVE" }).select("+sessionCookiesEncrypted");
    if (credential?.sessionCookiesEncrypted) return { ...info, run: true };
    const label = info.sessionBoard[0] + info.sessionBoard.slice(1).toLowerCase();
    return {
      ...info,
      run: false,
      reason:
        `${label} blocks automated browsers and ties applying to the candidate's own signed-in account. ` +
        `No saved ${label} session exists for this candidate, so a recruiter should apply by hand — or sign in once with ` +
        `"npm run board-login -- <candidateId> ${info.sessionBoard}" and the bot will apply here from then on`,
    };
  }
  return { ...info, run: true };
}
