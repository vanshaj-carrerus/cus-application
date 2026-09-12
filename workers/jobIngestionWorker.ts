import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { ingestJobsForProfile } from "@/lib/services/jobIngestionService";

export function startJobIngestionWorker() {
  return new Worker(
    QUEUE_NAMES.jobIngestion,
    async (job) => {
      const { profileId } = job.data as { profileId: string };
      return ingestJobsForProfile(profileId);
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );
}
