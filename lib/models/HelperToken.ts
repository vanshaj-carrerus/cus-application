import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * A pairing between one marketer and the desktop helper installed on their PC. Only a SHA-256 hash of the token is
 * stored; the token itself exists once, in the pairing link handed to that PC.
 */
export interface IHelperToken extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  label?: string;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

const HelperTokenSchema = new Schema<IHelperToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    label: String,
    lastUsedAt: Date,
    revokedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const HelperToken: Model<IHelperToken> = models.HelperToken || model<IHelperToken>("HelperToken", HelperTokenSchema);
