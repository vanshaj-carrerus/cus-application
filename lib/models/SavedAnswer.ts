import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * An answer to a question that application forms ask, remembered per candidate.
 *
 * Two ways a row appears:
 *   - a person adds one (recruiter on the candidate page, or the candidate in their portal): status ANSWERED
 *   - the bot hits a required question it can't answer from the profile and records it: status NEEDED, empty answer,
 *     waiting for a person to fill it in once — after which every future form that asks the same thing is answered.
 *
 * The bot never overrides a person's answer with a model-written one, and never invents an answer for a NEEDED row.
 */
export interface ISavedAnswer extends Document {
  candidateId: Types.ObjectId;
  /** Normalised question text — the lookup key (see normalizeQuestion in lib/automation/savedAnswers.ts). */
  questionKey: string;
  /** The question as it was worded on the form, for display. */
  question: string;
  answer: string;
  status: "ANSWERED" | "NEEDED";
  source: "STAFF" | "CANDIDATE" | "BOT";
  /** For choice questions: the options the form offered, so the person can pick instead of typing. */
  options?: string[];
  /** Where the bot first ran into it (host), for context. */
  askedOn?: string;
  timesUsed: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SavedAnswerSchema = new Schema<ISavedAnswer>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: "Candidate", required: true },
    questionKey: { type: String, required: true },
    question: { type: String, required: true },
    answer: { type: String, default: "" },
    status: { type: String, enum: ["ANSWERED", "NEEDED"], default: "ANSWERED" },
    source: { type: String, enum: ["STAFF", "CANDIDATE", "BOT"], default: "STAFF" },
    options: { type: [String], default: undefined },
    askedOn: String,
    timesUsed: { type: Number, default: 0 },
    lastUsedAt: Date,
  },
  { timestamps: true }
);

SavedAnswerSchema.index({ candidateId: 1, questionKey: 1 }, { unique: true });
SavedAnswerSchema.index({ candidateId: 1, status: 1 });

export const SavedAnswer: Model<ISavedAnswer> = models.SavedAnswer || model<ISavedAnswer>("SavedAnswer", SavedAnswerSchema);
