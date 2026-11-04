import { isGlassdoorHost, isIndeedHost, isLinkedInHost, isNaukriHost, isZipRecruiterHost, type ApplyPortal } from "../linkedin-shared";
import { runLinkedInApplyIfAsked, type Send } from "../linkedin-apply";
import { runGlassdoorApplyIfAsked } from "./glassdoor";
import { runIndeedApplyIfAsked } from "./indeed";
import { runZipRecruiterApplyIfAsked } from "./ziprecruiter";
import { runNaukriApplyIfAsked } from "./naukri";

/**
 * One adapter per portal. A page is handed to the adapter of ITS portal and to no other, so a portal's code only ever looks
 * for what that portal has. To add a portal: write its module in this folder, add its playbook to PLAYBOOKS.md, its pages to
 * urls.ts, and one line below.
 */
interface PortalAdapter {
  id: ApplyPortal;
  matchesHost: (hostname: string) => boolean;
  /** Does this page's part of a Start run (read the search, apply to the job, pass an in-between page). */
  run: (send: Send) => Promise<void>;
}

const ADAPTERS: PortalAdapter[] = [
  { id: "LINKEDIN", matchesHost: isLinkedInHost, run: runLinkedInApplyIfAsked },
  { id: "GLASSDOOR", matchesHost: isGlassdoorHost, run: runGlassdoorApplyIfAsked },
  { id: "INDEED", matchesHost: isIndeedHost, run: runIndeedApplyIfAsked },
  { id: "NAUKRI", matchesHost: isNaukriHost, run: runNaukriApplyIfAsked },
  { id: "ZIPRECRUITER", matchesHost: isZipRecruiterHost, run: runZipRecruiterApplyIfAsked },
];

export async function runPortalApplyIfAsked(send: Send) {
  await ADAPTERS.find((a) => a.matchesHost(location.hostname))?.run(send);
}
