import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { analyzeResumeQuality, tailorResume } from "@/lib/services/resumeService";

export function startResumeWorker() {
  return new Worker(
    QUEUE_NAMES.resume,
    async (job) => {
      await connectDB();
      const data = job.data as { type: "ANALYZE" | "TAILOR"; resumeId?: string; candidateId?: string; jobId?: string; userId?: string };
      if (data.type === "ANALYZE" && data.resumeId) {
        return analyzeResumeQuality(data.resumeId, { userId: data.userId });
      }
      if (data.type === "TAILOR" && data.candidateId && data.jobId) {
        return tailorResume(data.candidateId, data.jobId, { userId: data.userId });
      }
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );
}
