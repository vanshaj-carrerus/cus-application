import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { syncGmailHistory } from "@/lib/services/emailSyncService";

export function startEmailSyncWorker() {
  return new Worker(
    QUEUE_NAMES.emailSync,
    async (job) => {
      const { gmailAccountId } = job.data as { gmailAccountId: string };
      return syncGmailHistory(gmailAccountId);
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
}
