import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { AI_ACTIONS, type AiActionType } from "./enums";

export interface IAiAction extends Document {
  userId?: Types.ObjectId;
  action: AiActionType;
  tool?: string;
  entityType?: string;
  entityId?: Types.ObjectId;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: "SUCCESS" | "FAILED" | "REQUIRES_APPROVAL";
  createdAt: Date;
}

const AiActionSchema = new Schema<IAiAction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, enum: AI_ACTIONS, required: true },
    tool: String,
    entityType: String,
    entityId: Schema.Types.ObjectId,
    input: { type: Schema.Types.Mixed },
    output: { type: Schema.Types.Mixed },
    status: { type: String, enum: ["SUCCESS", "FAILED", "REQUIRES_APPROVAL"], default: "SUCCESS" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AiActionSchema.index({ userId: 1, createdAt: -1 });
AiActionSchema.index({ entityType: 1, entityId: 1 });

export const AiAction: Model<IAiAction> = models.AiAction || model<IAiAction>("AiAction", AiActionSchema);
