import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { matchCandidateToJob, bulkMatchCandidatesToJob } from "@/lib/services/matchingService";

export function startMatchingWorker() {
  return new Worker(
    QUEUE_NAMES.matching,
    async (job) => {
      await connectDB();
      const data = job.data as { candidateId?: string; jobId: string; candidateIds?: string[]; userId?: string };
      if (data.candidateIds?.length) {
        return bulkMatchCandidatesToJob(data.jobId, data.candidateIds, { userId: data.userId });
      }
      if (data.candidateId) {
        return matchCandidateToJob(data.candidateId, data.jobId, { userId: data.userId });
      }
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );
}
