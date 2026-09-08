import { AiAction } from "@/lib/models/AiAction";
import type { AiActionType } from "@/lib/models/enums";
import type { Types } from "mongoose";

export async function logAiAction(params: {
  userId?: string;
  action: AiActionType;
  tool?: string;
  entityType?: string;
  entityId?: string | Types.ObjectId;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status?: "SUCCESS" | "FAILED" | "REQUIRES_APPROVAL";
}) {
  await AiAction.create({
    userId: params.userId,
    action: params.action,
    tool: params.tool,
    entityType: params.entityType,
    entityId: params.entityId,
    input: params.input,
    output: params.output,
    status: params.status ?? "SUCCESS",
  });
}
