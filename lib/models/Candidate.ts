import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { CANDIDATE_STATUSES, type CandidateStatus } from "./enums";

export interface ICandidateExperience {
  title: string;
  company: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  description?: string;
}

export interface ICandidateEducation {
  institution: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
}

export interface ICandidateAiProfile {
  headline?: string;
  overview?: string;
  careerLevel?: string;
  primarySkills?: string[];
  bestFitRoles?: string[];
  strengths?: string[];
  potentialGaps?: string[];
  yearsOfExperience?: number;
  analyzedAt?: Date;
  model?: string;
}

export interface ICandidate extends Document {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  skills: string[];
  technicalSkills: string[];
  softSkills: string[];
  experience: ICandidateExperience[];
  education: ICandidateEducation[];
  certifications: string[];
  projects: { name: string; description?: string }[];
  industries: string[];
  yearsOfExperience?: number;
  careerLevel?: string;
  noticePeriod?: string;
  expectedSalary?: number;
  currency?: string;
  preferredRoles: string[];
  preferredLocations: string[];
  resumeFiles: { url: string; filename: string; uploadedAt: Date }[];
  resumeText?: string;
  aiProfile?: ICandidateAiProfile;
  status: CandidateStatus;
  assignedRecruiterId?: Types.ObjectId;
  lastContactedAt?: Date;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CandidateSchema = new Schema<ICandidate>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: String,
    location: String,
    skills: { type: [String], default: [] },
    technicalSkills: { type: [String], default: [] },
    softSkills: { type: [String], default: [] },
    experience: [
      {
        title: String,
        company: String,
        startDate: String,
        endDate: String,
        isCurrent: Boolean,
        description: String,
      },
    ],
    education: [
      {
        institution: String,
        degree: String,
        field: String,
        startDate: String,
        endDate: String,
      },
    ],
    certifications: { type: [String], default: [] },
    projects: [{ name: String, description: String }],
    industries: { type: [String], default: [] },
    yearsOfExperience: Number,
    careerLevel: String,
    noticePeriod: String,
    expectedSalary: Number,
    currency: String,
    preferredRoles: { type: [String], default: [] },
    preferredLocations: { type: [String], default: [] },
    resumeFiles: [{ url: String, filename: String, uploadedAt: Date }],
    resumeText: String,
    aiProfile: { type: Schema.Types.Mixed },
    status: { type: String, enum: CANDIDATE_STATUSES, default: "NEW" },
    assignedRecruiterId: { type: Schema.Types.ObjectId, ref: "User" },
    lastContactedAt: Date,
    source: String,
  },
  { timestamps: true }
);

CandidateSchema.index({ name: "text", resumeText: "text", skills: "text" });
CandidateSchema.index({ email: 1 });
CandidateSchema.index({ status: 1 });
CandidateSchema.index({ skills: 1 });
CandidateSchema.index({ assignedRecruiterId: 1 });

export const Candidate: Model<ICandidate> = models.Candidate || model<ICandidate>("Candidate", CandidateSchema);
