import { config } from "dotenv";
// Next's dev server auto-loads .env/.env.local, but this standalone process doesn't —
// load both explicitly (.env first, then .env.local to override) so it sees the same
// config Next does. This project's real config lives in .env, not .env.local.
config({ path: ".env" });
config({ path: ".env.local", override: true });
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
];

console.log(`RecruitAI background workers started: ${workers.length} queues listening.`);

process.on("SIGTERM", async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
