import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * "This run is working on this job." Several auto-apply runs can work for the same candidate at once; before opening a
 * job a run claims it here, and a job that is already claimed is left to the run that has it. Claims of unfinished jobs
 * are released straight away, and the rest expire on their own.
 */
export interface IPortalJobClaim extends Document {
  candidateId: Types.ObjectId;
  portal: string;
  externalJobId: string;
  createdAt: Date;
}

const PortalJobClaimSchema = new Schema<IPortalJobClaim>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    portal: { type: String, required: true },
    externalJobId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 30 * 60 },
  },
  { timestamps: false }
);

PortalJobClaimSchema.index({ candidateId: 1, portal: 1, externalJobId: 1 }, { unique: true });

export const PortalJobClaim: Model<IPortalJobClaim> = models.PortalJobClaim || model<IPortalJobClaim>("PortalJobClaim", PortalJobClaimSchema);
