import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { checkApplicationConfirmation } from "@/lib/automation/confirmationEmail";
import { connectDB } from "@/lib/db/mongodb";

/** Looks for the employer's "thanks for applying" email after an application was submitted (see confirmationEmail.ts). */
export function startConfirmationWorker() {
  return new Worker(
    QUEUE_NAMES.confirmationCheck,
    async (job) => {
      await connectDB();
      const { applicationId } = job.data as { applicationId: string };
      // The queue retries while the email hasn't arrived; the last scheduled try records "not found".
      const isLastTry = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return checkApplicationConfirmation(applicationId, isLastTry);
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
}
