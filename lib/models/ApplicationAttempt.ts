import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { JOB_BOARDS, ATTEMPT_STATUSES, type JobBoard, type AttemptStatus } from "./enums";

export interface IApplicationAttemptStep {
  step: string;
  status: "STARTED" | "SUCCESS" | "FAILED" | "SKIPPED";
  message?: string;
  screenshotUrl?: string;
  timestamp: Date;
}

export interface IApplicationAttempt extends Document {
  applicationId: Types.ObjectId;
  candidateId: Types.ObjectId;
  jobId: Types.ObjectId;
  board: JobBoard;
  attemptNumber: number;
  status: AttemptStatus;
  steps: IApplicationAttemptStep[];
  formFieldsFilled?: Record<string, unknown>;
  submissionConfirmation?: Record<string, unknown>;
  errorMessage?: string;
  startedAt: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApplicationAttemptSchema = new Schema<IApplicationAttempt>(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    board: { type: String, enum: JOB_BOARDS, required: true },
    attemptNumber: { type: Number, required: true, default: 1 },
    status: { type: String, enum: ATTEMPT_STATUSES, default: "PENDING" },
    steps: [
      {
        step: { type: String, required: true },
        status: { type: String, enum: ["STARTED", "SUCCESS", "FAILED", "SKIPPED"], required: true },
        message: String,
        screenshotUrl: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    formFieldsFilled: { type: Schema.Types.Mixed },
    submissionConfirmation: { type: Schema.Types.Mixed },
    errorMessage: String,
    startedAt: { type: Date, default: Date.now },
    finishedAt: Date,
  },
  { timestamps: true }
);

ApplicationAttemptSchema.index({ applicationId: 1, attemptNumber: -1 });
ApplicationAttemptSchema.index({ status: 1 });

export const ApplicationAttempt: Model<IApplicationAttempt> =
  models.ApplicationAttempt || model<IApplicationAttempt>("ApplicationAttempt", ApplicationAttemptSchema);
