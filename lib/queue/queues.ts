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
  // Auto-apply pipeline
  jobIngestion: "job-ingestion",
  resumeTailor: "resume-tailor",
  playwrightApply: "playwright-apply",
  emailSync: "email-sync",
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

// Auto-apply pipeline: job-ingestion-queue -> resume-tailor-queue -> playwright-apply-queue,
// with email-sync-queue running independently to poll/react to Gmail replies.
export const jobIngestionQueue = () => getQueue(QUEUE_NAMES.jobIngestion);
export const resumeTailorQueue = () => getQueue(QUEUE_NAMES.resumeTailor);
export const playwrightApplyQueue = () => getQueue(QUEUE_NAMES.playwrightApply);
export const emailSyncQueue = () => getQueue(QUEUE_NAMES.emailSync);
