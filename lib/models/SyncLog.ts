import { Schema, model, models, type Document, type Model } from "mongoose";

export interface ISyncLog extends Document {
  source: string;
  query?: Record<string, unknown>;
  status: "RUNNING" | "SUCCESS" | "FAILED";
  jobsFetched: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsDuplicate: number;
  jobsInvalid: number;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
}

const SyncLogSchema = new Schema<ISyncLog>({
  source: { type: String, required: true },
  query: { type: Schema.Types.Mixed },
  status: { type: String, enum: ["RUNNING", "SUCCESS", "FAILED"], default: "RUNNING" },
  jobsFetched: { type: Number, default: 0 },
  jobsCreated: { type: Number, default: 0 },
  jobsUpdated: { type: Number, default: 0 },
  jobsDuplicate: { type: Number, default: 0 },
  jobsInvalid: { type: Number, default: 0 },
  error: String,
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
});

SyncLogSchema.index({ source: 1, startedAt: -1 });

export const SyncLog: Model<ISyncLog> = models.SyncLog || model<ISyncLog>("SyncLog", SyncLogSchema);
