import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { analyzeCandidate } from "@/lib/services/candidateAnalysisService";

export function startCandidateAnalysisWorker() {
  return new Worker(
    QUEUE_NAMES.candidateAnalysis,
    async (job) => {
      await connectDB();
      const { candidateId, userId } = job.data as { candidateId: string; userId?: string };
      await analyzeCandidate(candidateId, { userId });
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
}
