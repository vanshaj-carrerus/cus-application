import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { AiConversation } from "@/lib/models/AiConversation";
import { runCopilotTurn, type CopilotMessage } from "@/lib/ai-tools/copilot";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const body = (await req.json()) as {
    conversationId?: string;
    message: string;
    confirmedToolCall?: { tool: string; args: Record<string, unknown> };
  };
  if (!body.message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  await connectDB();

  let conversation = body.conversationId
    ? await AiConversation.findById(body.conversationId)
    : null;
  if (!conversation) {
    conversation = await AiConversation.create({ userId: user.sub, conversationTitle: body.message.slice(0, 60), messages: [] });
  }

  const history: CopilotMessage[] = conversation.messages.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls }));

  const result = await runCopilotTurn(history, body.message, { userId: user.sub, role: user.role }, body.confirmedToolCall);

  conversation.messages.push({ role: "user", content: body.message, createdAt: new Date() });
  conversation.messages.push({
    role: "assistant",
    content: result.reply,
    toolCalls: result.toolCalls,
    createdAt: new Date(),
  });
  await conversation.save();

  return NextResponse.json({
    conversationId: conversation._id,
    reply: result.reply,
    toolCalls: result.toolCalls,
    pendingApproval: result.pendingApproval,
  });
}, "ai:copilot");
