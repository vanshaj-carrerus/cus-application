import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { AI_ANALYSIS_TYPES, AI_ANALYSIS_STATUSES, type AiAnalysisType, type AiAnalysisStatus } from "./enums";

export interface IAiAnalysis extends Document {
  type: AiAnalysisType;
  candidateId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  applicationId?: Types.ObjectId;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  score?: number;
  aiModel: string;
  status: AiAnalysisStatus;
  error?: string;
  inputHash?: string;
  createdAt: Date;
}

const AiAnalysisSchema = new Schema<IAiAnalysis>(
  {
    type: { type: String, enum: AI_ANALYSIS_TYPES, required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate" },
    jobId: { type: Schema.Types.ObjectId, ref: "Job" },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application" },
    input: { type: Schema.Types.Mixed, required: true },
    output: { type: Schema.Types.Mixed },
    score: Number,
    aiModel: { type: String, required: true },
    status: { type: String, enum: AI_ANALYSIS_STATUSES, default: "PENDING" },
    error: String,
    inputHash: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AiAnalysisSchema.index({ type: 1, inputHash: 1 });
AiAnalysisSchema.index({ candidateId: 1, type: 1 });
AiAnalysisSchema.index({ jobId: 1, type: 1 });
AiAnalysisSchema.index({ createdAt: -1 });

export const AiAnalysis: Model<IAiAnalysis> = models.AiAnalysis || model<IAiAnalysis>("AiAnalysis", AiAnalysisSchema);
