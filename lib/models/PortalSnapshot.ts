import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * What was last read from a candidate's account on a portal (profile, messages, jobs...), one row per candidate
 * per portal. Sections are stored as received from the extension (after server-side cleaning) so other portals can
 * reuse the same model with their own section names.
 */
export interface IPortalSnapshotSection {
  data: unknown;
  syncedAt: Date;
}

export interface IPortalSnapshot extends Document {
  candidateId: Types.ObjectId;
  portal: string;
  sections: Record<string, IPortalSnapshotSection>;
  /** The most recent sync run, so the UI can show progress and why a run failed. */
  run?: { state: "RUNNING" | "DONE" | "FAILED"; message?: string; startedAt: Date; finishedAt?: Date };
  /** The most recent auto-apply run on this portal (Start button): state, counters and a short log. */
  apply?: PortalApplyRun;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortalApplyRun {
  state: "RUNNING" | "PAUSED" | "STOPPING" | "DONE" | "STOPPED" | "FAILED";
  message?: string;
  startedAt: Date;
  finishedAt?: Date;
  /** How many runs (browser windows) are working for this candidate right now. */
  activeRuns: number;
  applied: number;
  skipped: number;
  failed: number;
  log: Array<{ at: Date; title: string; company?: string; outcome: string; reason?: string }>;
}

const PortalSnapshotSchema = new Schema<IPortalSnapshot>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    portal: { type: String, required: true },
    sections: { type: Schema.Types.Mixed, default: {} },
    apply: { type: Schema.Types.Mixed },
    run: {
      state: { type: String, enum: ["RUNNING", "DONE", "FAILED"] },
      message: String,
      startedAt: Date,
      finishedAt: Date,
    },
  },
  { timestamps: true, minimize: false }
);

PortalSnapshotSchema.index({ candidateId: 1, portal: 1 }, { unique: true });

export const PortalSnapshot: Model<IPortalSnapshot> = models.PortalSnapshot || model<IPortalSnapshot>("PortalSnapshot", PortalSnapshotSchema);
