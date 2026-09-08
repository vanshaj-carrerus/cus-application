import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { RECOMMENDATIONS, type Recommendation } from "./enums";

export interface IJobMatch extends Document {
  candidateId: Types.ObjectId;
  jobId: Types.ObjectId;
  overallScore: number;
  skillMatch: number;
  experienceMatch: number;
  locationMatch: number;
  educationMatch: number;
  seniorityMatch: number;
  salaryMatch: number;
  matchingSkills: string[];
  missingSkills: string[];
  strengths: string[];
  concerns: string[];
  riskFactors: string[];
  recommendation: Recommendation;
  explanation: string;
  aiModel: string;
  createdAt: Date;
  updatedAt: Date;
}

const JobMatchSchema = new Schema<IJobMatch>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    overallScore: { type: Number, required: true },
    skillMatch: { type: Number, default: 0 },
    experienceMatch: { type: Number, default: 0 },
    locationMatch: { type: Number, default: 0 },
    educationMatch: { type: Number, default: 0 },
    seniorityMatch: { type: Number, default: 0 },
    salaryMatch: { type: Number, default: 0 },
    matchingSkills: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    strengths: { type: [String], default: [] },
    concerns: { type: [String], default: [] },
    riskFactors: { type: [String], default: [] },
    recommendation: { type: String, enum: RECOMMENDATIONS, required: true },
    explanation: { type: String, required: true },
    aiModel: { type: String, required: true },
  },
  { timestamps: true }
);

JobMatchSchema.index({ candidateId: 1, jobId: 1 }, { unique: true });
JobMatchSchema.index({ jobId: 1, overallScore: -1 });
JobMatchSchema.index({ candidateId: 1, overallScore: -1 });

export const JobMatch: Model<IJobMatch> = models.JobMatch || model<IJobMatch>("JobMatch", JobMatchSchema);
