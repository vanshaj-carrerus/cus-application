import { Queue } from "bullmq";
import { getRedisConnection } from "./connection";

export const QUEUE_NAMES = {
  jobAnalysis: "job-analysis",
  candidateAnalysis: "candidate-analysis",
  matching: "matching",
  resume: "resume",
  email: "email",
  analytics: "analytics",
  notification: "notification",
} as const;

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queueCache = new Map<QueueName, Queue>();

function getQueue(name: QueueName): Queue {
  let queue = queueCache.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
    queueCache.set(name, queue);
  }
  return queue;
}

export const jobAnalysisQueue = () => getQueue(QUEUE_NAMES.jobAnalysis);
export const candidateAnalysisQueue = () => getQueue(QUEUE_NAMES.candidateAnalysis);
export const matchingQueue = () => getQueue(QUEUE_NAMES.matching);
export const resumeQueue = () => getQueue(QUEUE_NAMES.resume);
export const emailQueue = () => getQueue(QUEUE_NAMES.email);
export const analyticsQueue = () => getQueue(QUEUE_NAMES.analytics);
export const notificationQueue = () => getQueue(QUEUE_NAMES.notification);
