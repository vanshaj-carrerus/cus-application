import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

export interface IResumeAiQuality {
  score?: number;
  atsCompatibility?: number;
  missingInformation?: string[];
  skillsClarity?: string;
  experienceClarity?: string;
  formattingProblems?: string[];
  improvements?: string[];
  analyzedAt?: Date;
}

export interface IResume extends Document {
  candidateId: Types.ObjectId;
  jobId?: Types.ObjectId;
  version: number;
  label: string; // e.g. "v1" or "v3 - Startup Job"
  fileUrl?: string;
  fileType?: "PDF" | "DOCX" | "GENERATED";
  extractedText: string;
  tailoredContent?: string;
  isTailored: boolean;
  aiQuality?: IResumeAiQuality;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ResumeSchema = new Schema<IResume>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job" },
    version: { type: Number, required: true, default: 1 },
    label: { type: String, required: true },
    fileUrl: String,
    fileType: { type: String, enum: ["PDF", "DOCX", "GENERATED"] },
    extractedText: { type: String, required: true },
    tailoredContent: String,
    isTailored: { type: Boolean, default: false },
    aiQuality: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

ResumeSchema.index({ candidateId: 1, version: -1 });

export const Resume: Model<IResume> = models.Resume || model<IResume>("Resume", ResumeSchema);
