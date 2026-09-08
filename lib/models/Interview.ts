import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

export interface IInterview extends Document {
  applicationId: Types.ObjectId;
  candidateId: Types.ObjectId;
  jobId: Types.ObjectId;
  scheduledAt: Date;
  durationMinutes?: number;
  interviewerIds: Types.ObjectId[];
  type: "PHONE_SCREEN" | "TECHNICAL" | "BEHAVIORAL" | "ONSITE" | "FINAL";
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  generatedQuestions?: {
    category: string;
    question: string;
  }[];
  notes?: string;
  aiSummary?: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    concerns: string[];
    candidateQuestions: string[];
    recommendedNextStep: string;
    generatedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const InterviewSchema = new Schema<IInterview>(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    scheduledAt: { type: Date, required: true },
    durationMinutes: Number,
    interviewerIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    type: { type: String, enum: ["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "ONSITE", "FINAL"], default: "PHONE_SCREEN" },
    status: { type: String, enum: ["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"], default: "SCHEDULED" },
    generatedQuestions: [{ category: String, question: String }],
    notes: String,
    aiSummary: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

InterviewSchema.index({ scheduledAt: 1 });
InterviewSchema.index({ applicationId: 1 });

export const Interview: Model<IInterview> = models.Interview || model<IInterview>("Interview", InterviewSchema);
