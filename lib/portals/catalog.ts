export type PortalRegion = "GLOBAL" | "USA" | "INDIA";

export interface PortalDef {
  id: string;
  name: string;
  regions: PortalRegion[];
  loginUrl: string;
  /** What the candidate signs in with on this portal. */
  loginLabel: string;
  /** Short note shown on the card. */
  note?: string;
  /** Data is read by the browser extension from the candidate's own signed-in browser, so no password is needed. */
  extensionSync?: boolean;
  /** The candidate signs in to the portal in their own browser, so no password has to be stored. */
  loginInBrowser?: boolean;
  /** The extension can search and apply on this portal from the candidate's browser (Start button). */
  autoApply?: boolean;
  /** The profile URL identifies the account the extension must be signed in to. */
  profileUrlRequired?: boolean;
}

export const PORTAL_CATALOG: PortalDef[] = [
  { id: "LINKEDIN", name: "LinkedIn", regions: ["GLOBAL"], loginUrl: "https://www.linkedin.com/login", loginLabel: "Email or phone", extensionSync: true, autoApply: true, profileUrlRequired: true, note: "Reads your profile, messages and jobs, and applies to jobs, all from your own signed-in browser" },
  { id: "INDEED", name: "Indeed", regions: ["GLOBAL", "USA", "INDIA"], loginUrl: "https://secure.indeed.com/auth", loginLabel: "Email", note: "Indeed signs in with an emailed code by default" },
  { id: "NAUKRI", name: "Naukri", regions: ["INDIA"], loginUrl: "https://www.naukri.com/nlogin/login", loginLabel: "Email or username" },
  { id: "SIMPLYHIRED", name: "SimplyHired", regions: ["USA"], loginUrl: "https://www.simplyhired.com/account/login", loginLabel: "Email" },
  { id: "JOOBLE", name: "Jooble", regions: ["GLOBAL", "USA", "INDIA"], loginUrl: "https://jooble.org/account/login", loginLabel: "Email" },
  { id: "GLASSDOOR", name: "Glassdoor", regions: ["GLOBAL", "USA"], loginUrl: "https://www.glassdoor.com/profile/login_input.htm", loginLabel: "Email", autoApply: true, loginInBrowser: true, note: "Searches and applies from your own signed-in browser" },
  { id: "ZIPRECRUITER", name: "ZipRecruiter", regions: ["USA"], loginUrl: "https://www.ziprecruiter.com/authn/login", loginLabel: "Email" },
  { id: "MONSTER", name: "Monster", regions: ["USA", "GLOBAL"], loginUrl: "https://www.monster.com/profile/signin", loginLabel: "Email" },
  { id: "DICE", name: "Dice", regions: ["USA"], loginUrl: "https://www.dice.com/dashboard/login", loginLabel: "Email" },
  { id: "CAREERBUILDER", name: "CareerBuilder", regions: ["USA"], loginUrl: "https://www.careerbuilder.com/login", loginLabel: "Email" },
  { id: "WELLFOUND", name: "Wellfound", regions: ["USA", "GLOBAL"], loginUrl: "https://wellfound.com/login", loginLabel: "Email", note: "Startup jobs" },
  { id: "FOUNDIT", name: "foundit (Monster India)", regions: ["INDIA"], loginUrl: "https://www.foundit.in/seeker/login", loginLabel: "Email or mobile" },
  { id: "SHINE", name: "Shine", regions: ["INDIA"], loginUrl: "https://www.shine.com/myshine/login/", loginLabel: "Email or mobile" },
  { id: "INSTAHYRE", name: "Instahyre", regions: ["INDIA"], loginUrl: "https://www.instahyre.com/login/", loginLabel: "Email" },
  { id: "HIRIST", name: "Hirist", regions: ["INDIA"], loginUrl: "https://www.hirist.tech/login", loginLabel: "Email", note: "Tech jobs" },
  { id: "TIMESJOBS", name: "TimesJobs", regions: ["INDIA"], loginUrl: "https://www.timesjobs.com/candidate/login.html", loginLabel: "Email" },
];

export const PORTAL_IDS = PORTAL_CATALOG.map((p) => p.id);

export function getPortal(id: string): PortalDef | undefined {
  return PORTAL_CATALOG.find((p) => p.id === id);
}
