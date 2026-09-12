import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { EMAIL_THREAD_STATUSES, type EmailThreadStatus } from "./enums";

export interface IEmailThreadMessage {
  gmailMessageId: string;
  direction: "OUTBOUND" | "INBOUND";
  from: string;
  to: string[];
  subject: string;
  snippet?: string;
  bodyText?: string;
  sentAt: Date;
  aiClassification?: string;
}

export interface IEmailThread extends Document {
  gmailAccountId: Types.ObjectId;
  gmailThreadId: string;
  candidateId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  applicationId?: Types.ObjectId;
  subject: string;
  participants: string[];
  status: EmailThreadStatus;
  messages: IEmailThreadMessage[];
  lastMessageAt: Date;
  aiSuggestedReply?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EmailThreadSchema = new Schema<IEmailThread>(
  {
    gmailAccountId: { type: Schema.Types.ObjectId, ref: "GmailAccount", required: true },
    gmailThreadId: { type: String, required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate" },
    jobId: { type: Schema.Types.ObjectId, ref: "Job" },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application" },
    subject: { type: String, required: true },
    participants: { type: [String], default: [] },
    status: { type: String, enum: EMAIL_THREAD_STATUSES, default: "OPEN" },
    messages: [
      {
        gmailMessageId: { type: String, required: true },
        direction: { type: String, enum: ["OUTBOUND", "INBOUND"], required: true },
        from: { type: String, required: true },
        to: { type: [String], default: [] },
        subject: String,
        snippet: String,
        bodyText: String,
        sentAt: { type: Date, required: true },
        aiClassification: String,
      },
    ],
    lastMessageAt: { type: Date, default: Date.now },
    aiSuggestedReply: String,
  },
  { timestamps: true }
);

EmailThreadSchema.index({ gmailAccountId: 1, gmailThreadId: 1 }, { unique: true });
EmailThreadSchema.index({ applicationId: 1 });
EmailThreadSchema.index({ candidateId: 1, lastMessageAt: -1 });
EmailThreadSchema.index({ status: 1 });

export const EmailThread: Model<IEmailThread> =
  models.EmailThread || model<IEmailThread>("EmailThread", EmailThreadSchema);
