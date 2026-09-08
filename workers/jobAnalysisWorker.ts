import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { analyzeJob } from "@/lib/services/jobAnalysisService";
import { predictJobDifficulty } from "@/lib/services/jobDifficultyService";

export function startJobAnalysisWorker() {
  return new Worker(
    QUEUE_NAMES.jobAnalysis,
    async (job) => {
      await connectDB();
      const { jobId, userId } = job.data as { jobId: string; userId?: string };
      await analyzeJob(jobId, { userId });
      await predictJobDifficulty(jobId, { userId });
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
}
