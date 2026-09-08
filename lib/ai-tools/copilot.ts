import { env } from "@/lib/env";
import { TOOLS, getToolByName, isToolAuthorized, type ToolContext } from "./tools";
import { logAiAction } from "@/lib/ai/log-action";
import type { Role } from "@/lib/models/enums";

export interface CopilotMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { tool: string; args: Record<string, unknown>; result?: unknown }[];
}

export interface CopilotTurnResult {
  reply: string;
  toolCalls: { tool: string; args: Record<string, unknown>; result: unknown }[];
  pendingApproval?: { tool: string; args: Record<string, unknown> };
}

const SYSTEM_INSTRUCTION = `You are the Recruitment Copilot inside an AI-first recruitment platform. You help recruiters discover jobs, understand jobs, find and evaluate candidates, prepare applications, and manage communication.

Rules:
- You may ONLY use the provided tools to read or write platform data. Never claim to have done something you did not actually call a tool for.
- Never invent candidate facts, job facts, or application status. Only state what tools return.
- For high-impact actions (status changes, external communication), the tool itself will require separate human confirmation — tell the user you need their confirmation rather than assuming it happened.
- Be concise and concrete. When you find candidates or jobs, summarize the top results rather than dumping raw data.
- Explain WHY, not just WHAT (e.g. explain match scores, not just state them).`;

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}
interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
}

function toolsForRole(role: Role) {
  return TOOLS.filter((t) => isToolAuthorized(t, role)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

const RETRYABLE_STATUSES = new Set([429, 500, 503]);

async function callGeminiWithTools(contents: GeminiContent[], role: Role, attempt = 0): Promise<GeminiResponse> {
  const url = `${env.aiApiUrl}/models/${env.aiModel}:generateContent?key=${env.aiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: [{ functionDeclarations: toolsForRole(role) }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    if (RETRYABLE_STATUSES.has(res.status) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      return callGeminiWithTools(contents, role, attempt + 1);
    }
    const body = await res.text().catch(() => "");
    throw new Error(`Copilot AI request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<GeminiResponse>;
}

function historyToContents(history: CopilotMessage[]): GeminiContent[] {
  return history.map((m) => ({
    role: m.role === "assistant" ? "model" : m.role === "tool" ? "function" : "user",
    parts: [{ text: m.content }],
  }));
}

export async function runCopilotTurn(
  history: CopilotMessage[],
  userMessage: string,
  ctx: ToolContext,
  confirmedToolCall?: { tool: string; args: Record<string, unknown> }
): Promise<CopilotTurnResult> {
  const contents: GeminiContent[] = [...historyToContents(history), { role: "user", parts: [{ text: userMessage }] }];
  const executedToolCalls: { tool: string; args: Record<string, unknown>; result: unknown }[] = [];

  // If the frontend is re-invoking after the user confirmed a high-impact action,
  // execute that one tool immediately and feed the result back in.
  if (confirmedToolCall) {
    const tool = getToolByName(confirmedToolCall.tool);
    if (tool && isToolAuthorized(tool, ctx.role)) {
      const result = await tool.execute(confirmedToolCall.args, ctx);
      executedToolCalls.push({ tool: tool.name, args: confirmedToolCall.args, result });
      await logAiAction({
        userId: ctx.userId,
        action: "AI_COPILOT_TOOL_CALL",
        tool: tool.name,
        input: confirmedToolCall.args,
        output: result as Record<string, unknown>,
      });
      contents.push({ role: "function", parts: [{ functionResponse: { name: tool.name, response: { result } } }] });
    }
  }

  for (let iteration = 0; iteration < 4; iteration++) {
    const response = await callGeminiWithTools(contents, ctx.role);
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart?.functionCall) {
      const text = parts.map((p) => p.text ?? "").join("");
      return { reply: text || "I couldn't generate a response.", toolCalls: executedToolCalls };
    }

    const { name, args } = functionCallPart.functionCall;
    const tool = getToolByName(name);

    if (!tool || !isToolAuthorized(tool, ctx.role)) {
      contents.push({ role: "model", parts: [{ functionCall: { name, args } }] });
      contents.push({ role: "function", parts: [{ functionResponse: { name, response: { error: "Tool not authorized for this role" } } }] });
      continue;
    }

    if (tool.requiresApproval) {
      return {
        reply: `This action (${tool.name}) needs your confirmation before I proceed: ${JSON.stringify(args)}`,
        toolCalls: executedToolCalls,
        pendingApproval: { tool: tool.name, args },
      };
    }

    const result = await tool.execute(args, ctx);
    executedToolCalls.push({ tool: tool.name, args, result });

    await logAiAction({
      userId: ctx.userId,
      action: "AI_COPILOT_TOOL_CALL",
      tool: tool.name,
      input: args,
      output: result as Record<string, unknown>,
    });

    contents.push({ role: "model", parts: [{ functionCall: { name, args } }] });
    contents.push({ role: "function", parts: [{ functionResponse: { name, response: { result } } }] });
  }

  return { reply: "I've gathered the information but reached the tool-call limit for this turn. Please ask a follow-up.", toolCalls: executedToolCalls };
}
