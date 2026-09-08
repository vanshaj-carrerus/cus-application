import { config } from "dotenv";
config({ path: ".env.local" });
import { startJobAnalysisWorker } from "./jobAnalysisWorker";
import { startCandidateAnalysisWorker } from "./candidateAnalysisWorker";
import { startMatchingWorker } from "./matchingWorker";
import { startResumeWorker } from "./resumeWorker";
import { startEmailWorker } from "./emailWorker";
import { startNotificationWorker } from "./notificationWorker";
import { startAnalyticsWorker } from "./analyticsWorker";

const workers = [
  startJobAnalysisWorker(),
  startCandidateAnalysisWorker(),
  startMatchingWorker(),
  startResumeWorker(),
  startEmailWorker(),
  startNotificationWorker(),
  startAnalyticsWorker(),
];

console.log(`RecruitAI background workers started: ${workers.length} queues listening.`);

process.on("SIGTERM", async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
