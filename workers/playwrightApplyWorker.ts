import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { runApplyFlow } from "@/lib/automation/applyEngine";

export function startPlaywrightApplyWorker() {
  return new Worker(
    QUEUE_NAMES.playwrightApply,
    async (job) => {
      const { applicationId } = job.data as { applicationId: string };
      return runApplyFlow(applicationId);
    },
    // Each job drives a real headless browser end to end — keep concurrency low.
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
