import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { OWNER_TYPES, GMAIL_ACCOUNT_STATUSES, type OwnerType, type GmailAccountStatus } from "./enums";

export interface IGmailAccount extends Document {
  ownerType: OwnerType;
  ownerId: Types.ObjectId;
  emailAddress: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiryDate: Date;
  scope: string;
  historyId?: string;
  watchExpiration?: Date;
  status: GmailAccountStatus;
  lastSyncedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GmailAccountSchema = new Schema<IGmailAccount>(
  {
    ownerType: { type: String, enum: OWNER_TYPES, required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    emailAddress: { type: String, required: true, lowercase: true, trim: true },
    accessTokenEncrypted: { type: String, required: true, select: false },
    refreshTokenEncrypted: { type: String, required: true, select: false },
    tokenExpiryDate: { type: Date, required: true },
    scope: { type: String, required: true },
    historyId: String,
    watchExpiration: Date,
    status: { type: String, enum: GMAIL_ACCOUNT_STATUSES, default: "CONNECTED" },
    lastSyncedAt: Date,
    lastError: String,
  },
  { timestamps: true }
);

GmailAccountSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });
GmailAccountSchema.index({ emailAddress: 1 }, { unique: true });

export const GmailAccount: Model<IGmailAccount> =
  models.GmailAccount || model<IGmailAccount>("GmailAccount", GmailAccountSchema);
