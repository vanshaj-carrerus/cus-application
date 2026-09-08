import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

export interface IAiMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { tool: string; args: Record<string, unknown>; result?: unknown }[];
  createdAt: Date;
}

export interface IAiConversation extends Document {
  userId: Types.ObjectId;
  conversationTitle: string;
  messages: IAiMessage[];
  context?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const AiConversationSchema = new Schema<IAiConversation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    conversationTitle: { type: String, default: "New conversation" },
    messages: [
      {
        role: { type: String, enum: ["user", "assistant", "tool"], required: true },
        content: { type: String, required: true },
        toolCalls: [{ tool: String, args: Schema.Types.Mixed, result: Schema.Types.Mixed }],
        createdAt: { type: Date, default: Date.now },
      },
    ],
    context: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

AiConversationSchema.index({ userId: 1, updatedAt: -1 });

export const AiConversation: Model<IAiConversation> = models.AiConversation || model<IAiConversation>("AiConversation", AiConversationSchema);
