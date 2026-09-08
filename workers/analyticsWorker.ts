import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { computeRecruitmentAnalytics } from "@/lib/services/analyticsService";

export function startAnalyticsWorker() {
  return new Worker(
    QUEUE_NAMES.analytics,
    async () => {
      await connectDB();
      return computeRecruitmentAnalytics();
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
