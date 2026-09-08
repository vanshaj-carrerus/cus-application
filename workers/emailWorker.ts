import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { generateEmail, type EmailCategory } from "@/lib/services/emailService";

export function startEmailWorker() {
  return new Worker(
    QUEUE_NAMES.email,
    async (job) => {
      await connectDB();
      const data = job.data as {
        category: EmailCategory;
        candidateId?: string;
        jobId?: string;
        applicationId?: string;
        tone?: "PROFESSIONAL" | "FRIENDLY" | "SHORT" | "FORMAL";
        userId?: string;
      };
      return generateEmail(data);
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
}
