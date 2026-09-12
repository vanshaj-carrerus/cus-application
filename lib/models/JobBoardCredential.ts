import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { JOB_BOARDS, CREDENTIAL_STATUSES, type JobBoard, type CredentialStatus } from "./enums";

export interface IJobBoardCredential extends Document {
  candidateId: Types.ObjectId;
  board: JobBoard;
  hostname?: string; // required when board === "OTHER" — matches an arbitrary ATS/employer login domain
  boardUsername: string;
  passwordEncrypted: string;
  sessionCookiesEncrypted?: string;
  status: CredentialStatus;
  lastUsedAt?: Date;
  lastVerifiedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const JobBoardCredentialSchema = new Schema<IJobBoardCredential>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    board: { type: String, enum: JOB_BOARDS, required: true },
    hostname: { type: String, trim: true, lowercase: true },
    boardUsername: { type: String, required: true },
    passwordEncrypted: { type: String, required: true, select: false },
    sessionCookiesEncrypted: { type: String, select: false },
    status: { type: String, enum: CREDENTIAL_STATUSES, default: "ACTIVE" },
    lastUsedAt: Date,
    lastVerifiedAt: Date,
    lastError: String,
  },
  { timestamps: true }
);

// hostname is part of the uniqueness key so a candidate can hold multiple OTHER
// credentials (one per employer/ATS domain) alongside their named-board ones.
JobBoardCredentialSchema.index({ candidateId: 1, board: 1, hostname: 1 }, { unique: true });

export const JobBoardCredential: Model<IJobBoardCredential> =
  models.JobBoardCredential || model<IJobBoardCredential>("JobBoardCredential", JobBoardCredentialSchema);
