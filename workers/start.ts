import { config } from "dotenv";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// Next's dev server auto-loads .env/.env.local, but this standalone process doesn't —
// load both explicitly (.env first, then .env.local to override) so it sees the same
// config Next does. This project's real config lives in .env, not .env.local.
config({ path: ".env" });
config({ path: ".env.local", override: true });
import { installDefaultFetchTimeout } from "../lib/net/defaultTimeout";
installDefaultFetchTimeout();
import { startJobAnalysisWorker } from "./jobAnalysisWorker";
import { startCandidateAnalysisWorker } from "./candidateAnalysisWorker";
import { startMatchingWorker } from "./matchingWorker";
import { startResumeWorker } from "./resumeWorker";
import { startEmailWorker } from "./emailWorker";
import { startNotificationWorker } from "./notificationWorker";
import { startAnalyticsWorker } from "./analyticsWorker";
import { startJobIngestionWorker } from "./jobIngestionWorker";
import { startResumeTailorWorker } from "./resumeTailorWorker";
import { startPlaywrightApplyWorker } from "./playwrightApplyWorker";
import { startEmailSyncWorker } from "./emailSyncWorker";
import { startConfirmationWorker } from "./confirmationWorker";

// `tsx` loads the code once; editing a file afterwards changes nothing in a running worker, which makes 
// fixes look like they "didn't work". Say so loudly instead of letting it run stale.
const startedAt = Date.now();
function newestSourceChange(): { file: string; at: number } | null {
  let newest: { file: string; at: number } | null = null;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const at = statSync(full).mtimeMs;
        if (!newest || at > newest.at) newest = { file: full, at };
      }
    }
  };
  for (const dir of ["lib", "workers"]) walk(dir);
  return newest;
}
console.log(`[workers] started ${new Date(startedAt).toLocaleString()}`);
let warnedStale = false;
setInterval(() => {
  const change = newestSourceChange();
  if (change && change.at > startedAt && !warnedStale) {
    warnedStale = true;
    console.warn(`[workers] ⚠ ${change.file} changed after this worker started — RESTART it (Ctrl+C, npm run workers) or it keeps running the old code`);
  }
}, 30_000).unref();

const workers = [
  startJobAnalysisWorker(),
  startCandidateAnalysisWorker(),
  startMatchingWorker(),
  startResumeWorker(),
  startEmailWorker(),
  startNotificationWorker(),
  startAnalyticsWorker(),
  startJobIngestionWorker(),
  startResumeTailorWorker(),
  startPlaywrightApplyWorker(),
  startEmailSyncWorker(),
  startConfirmationWorker(),
];

console.log(`RecruitAI background workers started: ${workers.length} queues listening.`);

process.on("SIGTERM", async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
