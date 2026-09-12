import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { JOB_BOARDS, AUTO_APPLY_MODES, EMPLOYMENT_TYPES, REMOTE_TYPES, type JobBoard, type AutoApplyMode, type EmploymentType, type RemoteType } from "./enums";

export interface IAutoApplyProfile extends Document {
  candidateId: Types.ObjectId;
  enabled: boolean;
  boards: JobBoard[];
  keywords: string[];
  excludeKeywords: string[];
  locations: string[];
  remotePreference: RemoteType[];
  employmentTypes: EmploymentType[];
  minSalary?: number;
  currency?: string;
  dailyApplyLimit: number;
  appliedToday: number;
  appliedTodayResetAt: Date;
  mode: AutoApplyMode;
  requireCoverLetter: boolean;
  baseResumeId?: Types.ObjectId;
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AutoApplyProfileSchema = new Schema<IAutoApplyProfile>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true, unique: true },
    enabled: { type: Boolean, default: false },
    boards: { type: [String], enum: JOB_BOARDS, default: [] },
    keywords: { type: [String], default: [] },
    excludeKeywords: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    remotePreference: { type: [String], enum: REMOTE_TYPES, default: [] },
    employmentTypes: { type: [String], enum: EMPLOYMENT_TYPES, default: [] },
    minSalary: Number,
    currency: String,
    dailyApplyLimit: { type: Number, default: 10 },
    appliedToday: { type: Number, default: 0 },
    appliedTodayResetAt: { type: Date, default: Date.now },
    mode: { type: String, enum: AUTO_APPLY_MODES, default: "REVIEW_FIRST" },
    requireCoverLetter: { type: Boolean, default: true },
    baseResumeId: { type: Schema.Types.ObjectId, ref: "Resume" },
    lastRunAt: Date,
    nextRunAt: Date,
  },
  { timestamps: true }
);

AutoApplyProfileSchema.index({ enabled: 1, nextRunAt: 1 });

export const AutoApplyProfile: Model<IAutoApplyProfile> =
  models.AutoApplyProfile || model<IAutoApplyProfile>("AutoApplyProfile", AutoApplyProfileSchema);
