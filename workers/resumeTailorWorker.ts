import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { tailorApplicationForJob } from "@/lib/services/resumeTailorService";

export function startResumeTailorWorker() {
  return new Worker(
    QUEUE_NAMES.resumeTailor,
    async (job) => {
      const { applicationId } = job.data as { applicationId: string };
      return tailorApplicationForJob(applicationId);
    },
    // Renders a headless-Chromium PDF per job — keep concurrency low to bound memory.
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
