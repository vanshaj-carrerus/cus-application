import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { JOB_STATUSES, REMOTE_TYPES, EMPLOYMENT_TYPES, JOB_DIFFICULTIES, type JobStatus, type RemoteType, type EmploymentType, type JobDifficulty } from "./enums";

export interface IJobAiAnalysis {
  summary?: string;
  mustHaveSkills?: string[];
  niceToHaveSkills?: string[];
  hiddenRequirements?: { text: string; inferred: true }[];
  screeningQuestions?: string[];
  searchKeywords?: string[];
  seniority?: string;
  industry?: string;
  qualityScore?: number;
  qualityBreakdown?: {
    descriptionQuality?: number;
    skillClarity?: number;
    experienceClarity?: number;
    salaryTransparency?: number;
    locationClarity?: number;
    requirementClarity?: number;
  };
  qualityIssues?: string[];
  analyzedAt?: Date;
  model?: string;
}

export interface IJob extends Document {
  externalJobId: string;
  source: string;
  sourceUrl?: string;
  applicationUrl?: string;
  title: string;
  company: string;
  companyId?: Types.ObjectId;
  clientId?: Types.ObjectId;
  description: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  remoteType: RemoteType;
  employmentType: EmploymentType;
  experienceMin?: number;
  experienceMax?: number;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  skills: string[];
  requirements: string[];
  qualifications: string[];
  responsibilities: string[];
  benefits: string[];
  postedAt?: Date;
  expiresAt?: Date;
  status: JobStatus;
  aiAnalysis?: IJobAiAnalysis;
  aiScore?: number;
  aiDifficulty?: JobDifficulty;
  aiDifficultyReasoning?: string;
  ownerRecruiterId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const JobSchema = new Schema<IJob>(
  {
    externalJobId: { type: String, required: true },
    source: { type: String, required: true },
    sourceUrl: String,
    applicationUrl: String,
    title: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Company" },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    description: { type: String, required: true },
    location: String,
    city: String,
    state: String,
    country: String,
    remoteType: { type: String, enum: REMOTE_TYPES, default: "UNKNOWN" },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: "UNKNOWN" },
    experienceMin: Number,
    experienceMax: Number,
    salaryMin: Number,
    salaryMax: Number,
    currency: String,
    skills: { type: [String], default: [] },
    requirements: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    responsibilities: { type: [String], default: [] },
    benefits: { type: [String], default: [] },
    postedAt: Date,
    expiresAt: Date,
    status: { type: String, enum: JOB_STATUSES, default: "ACTIVE" },
    aiAnalysis: { type: Schema.Types.Mixed },
    aiScore: Number,
    aiDifficulty: { type: String, enum: JOB_DIFFICULTIES },
    aiDifficultyReasoning: String,
    ownerRecruiterId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

JobSchema.index({ source: 1, externalJobId: 1 }, { unique: true });
JobSchema.index({ title: "text", description: "text", skills: "text" });
JobSchema.index({ status: 1, postedAt: -1 });
JobSchema.index({ city: 1, remoteType: 1 });
JobSchema.index({ skills: 1 });

export const Job: Model<IJob> = models.Job || model<IJob>("Job", JobSchema);
