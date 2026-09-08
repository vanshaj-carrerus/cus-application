import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

export interface IEmail extends Document {
  fromUserId?: Types.ObjectId;
  candidateId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  applicationId?: Types.ObjectId;
  to: string;
  subject: string;
  body: string;
  tone?: "PROFESSIONAL" | "FRIENDLY" | "SHORT" | "FORMAL";
  category?: "OUTREACH" | "INTERVIEW_INVITE" | "FOLLOW_UP" | "REJECTION" | "OFFER" | "APPLICATION_UPDATE" | "CLIENT_UPDATE" | "OTHER";
  direction: "OUTBOUND" | "INBOUND";
  status: "DRAFT" | "SENT" | "FAILED";
  aiGenerated: boolean;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailSchema = new Schema<IEmail>(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: "User" },
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate" },
    jobId: { type: Schema.Types.ObjectId, ref: "Job" },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application" },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    tone: { type: String, enum: ["PROFESSIONAL", "FRIENDLY", "SHORT", "FORMAL"] },
    category: {
      type: String,
      enum: ["OUTREACH", "INTERVIEW_INVITE", "FOLLOW_UP", "REJECTION", "OFFER", "APPLICATION_UPDATE", "CLIENT_UPDATE", "OTHER"],
    },
    direction: { type: String, enum: ["OUTBOUND", "INBOUND"], default: "OUTBOUND" },
    status: { type: String, enum: ["DRAFT", "SENT", "FAILED"], default: "DRAFT" },
    aiGenerated: { type: Boolean, default: false },
    sentAt: Date,
  },
  { timestamps: true }
);

EmailSchema.index({ candidateId: 1, createdAt: -1 });
EmailSchema.index({ applicationId: 1 });

export const Email: Model<IEmail> = models.Email || model<IEmail>("Email", EmailSchema);
