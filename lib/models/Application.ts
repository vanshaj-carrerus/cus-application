import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { APPLICATION_STATUSES, AUTOMATION_STATUSES, type ApplicationStatus, type AutomationStatus } from "./enums";

export interface IApplicationTimelineEntry {
  status: ApplicationStatus;
  note?: string;
  changedBy?: Types.ObjectId;
  changedAt: Date;
}

export interface IApplication extends Document {
  candidateId: Types.ObjectId;
  jobId: Types.ObjectId;
  recruiterId: Types.ObjectId;
  clientId?: Types.ObjectId;
  matchScore?: number;
  status: ApplicationStatus;
  resumeVersionId?: Types.ObjectId;
  coverLetter?: string;
  appliedAt?: Date;
  interviewDate?: Date;
  notes: { text: string; authorId: Types.ObjectId; createdAt: Date }[];
  timeline: IApplicationTimelineEntry[];
  automationStatus: AutomationStatus;
  /** Set when a marketer clicks Apply: their desktop helper claims the application from here. */
  assist?: { requestedBy?: Types.ObjectId; requestedAt?: Date; claimedAt?: Date };
  appliedBy?: Types.ObjectId;
  confirmationData?: Record<string, unknown>;
  applicationProofScreenshot?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ApplicationSchema = new Schema<IApplication>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    recruiterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    matchScore: Number,
    status: { type: String, enum: APPLICATION_STATUSES, default: "DRAFT" },
    resumeVersionId: { type: Schema.Types.ObjectId, ref: "Resume" },
    coverLetter: String,
    appliedAt: Date,
    interviewDate: Date,
    notes: [{ text: String, authorId: { type: Schema.Types.ObjectId, ref: "User" }, createdAt: { type: Date, default: Date.now } }],
    timeline: [
      {
        status: { type: String, enum: APPLICATION_STATUSES },
        note: String,
        changedBy: { type: Schema.Types.ObjectId, ref: "User" },
        changedAt: { type: Date, default: Date.now },
      },
    ],
    automationStatus: { type: String, enum: AUTOMATION_STATUSES, default: "NOT_QUEUED" },
    assist: {
      requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
      requestedAt: Date,
      claimedAt: Date,
    },
    appliedBy: { type: Schema.Types.ObjectId, ref: "User" },
    confirmationData: { type: Schema.Types.Mixed },
    applicationProofScreenshot: String,
    failureReason: String,
  },
  { timestamps: true }
);

ApplicationSchema.index({ candidateId: 1, jobId: 1 }, { unique: true });
ApplicationSchema.index({ status: 1 });
ApplicationSchema.index({ automationStatus: 1, "assist.requestedBy": 1, "assist.requestedAt": 1 });
ApplicationSchema.index({ candidateId: 1, automationStatus: 1, updatedAt: -1 });
ApplicationSchema.index({ automationStatus: 1, updatedAt: -1 });
ApplicationSchema.index({ appliedBy: 1, appliedAt: -1 });
ApplicationSchema.index({ recruiterId: 1, status: 1 });
ApplicationSchema.index({ jobId: 1, status: 1 });

export const Application: Model<IApplication> = models.Application || model<IApplication>("Application", ApplicationSchema);
