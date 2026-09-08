import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { connectDB } from "@/lib/db/mongodb";
import { Notification } from "@/lib/models/Notification";
import type { NotificationType } from "@/lib/models/enums";

export function startNotificationWorker() {
  return new Worker(
    QUEUE_NAMES.notification,
    async (job) => {
      await connectDB();
      const data = job.data as { userId: string; type: NotificationType; title: string; message: string; entityType?: string; entityId?: string };
      await Notification.create(data);
    },
    { connection: getRedisConnection(), concurrency: 5 }
  );
}
