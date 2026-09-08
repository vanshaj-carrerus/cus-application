import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

export interface ITask extends Document {
  assignedTo: Types.ObjectId;
  title: string;
  description?: string;
  entityType?: "CANDIDATE" | "JOB" | "APPLICATION" | "CLIENT";
  entityId?: Types.ObjectId;
  dueDate?: Date;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  source: "MANUAL" | "AI_SUGGESTED";
  aiReasoning?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<ITask>(
  {
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    description: String,
    entityType: { type: String, enum: ["CANDIDATE", "JOB", "APPLICATION", "CLIENT"] },
    entityId: Schema.Types.ObjectId,
    dueDate: Date,
    priority: { type: String, enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" },
    status: { type: String, enum: ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"], default: "OPEN" },
    source: { type: String, enum: ["MANUAL", "AI_SUGGESTED"], default: "MANUAL" },
    aiReasoning: String,
  },
  { timestamps: true }
);

TaskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });

export const Task: Model<ITask> = models.Task || model<ITask>("Task", TaskSchema);
