import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { CREDENTIAL_STATUSES, type CredentialStatus } from "./enums";
import { PORTAL_IDS } from "@/lib/portals/catalog";

/**
 * A candidate's account on an external job portal (LinkedIn, Indeed, Naukri, ...).
 *
 * Most portals have no public API for a candidate's own account, so the connection is the candidate's login,
 * stored encrypted (AES-256-GCM, see lib/security/crypto.ts) and never returned by any API. `status` stays
 * PENDING until a verification login confirms it — until then a saved connection is not proof it works.
 */
export interface IPortalConnection extends Document {
  candidateId: Types.ObjectId;
  portal: string;
  loginId: string;
  /** Empty for portals that sync through the extension and need no stored password. */
  encryptedPassword?: string;
  status: CredentialStatus | "PENDING";
  statusNote?: string;
  profileUrl?: string;
  connectedByUserId?: Types.ObjectId;
  lastVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PortalConnectionSchema = new Schema<IPortalConnection>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    portal: { type: String, enum: PORTAL_IDS, required: true },
    loginId: { type: String, required: true },
    encryptedPassword: { type: String, select: false },
    status: { type: String, enum: [...CREDENTIAL_STATUSES, "PENDING"], default: "PENDING" },
    statusNote: String,
    profileUrl: String,
    connectedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    lastVerifiedAt: Date,
  },
  { timestamps: true }
);

PortalConnectionSchema.index({ candidateId: 1, portal: 1 }, { unique: true });

export const PortalConnection: Model<IPortalConnection> =
  models.PortalConnection || model<IPortalConnection>("PortalConnection", PortalConnectionSchema);
