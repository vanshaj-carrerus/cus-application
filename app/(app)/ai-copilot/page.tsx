"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, Send, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  pendingApproval?: { tool: string; args: Record<string, unknown> };
}

const SUGGESTED_PROMPTS = [
  "Which candidates should I contact today?",
  "Find me a senior React developer in Ahmedabad with 5+ years experience.",
  "Show remote Java jobs.",
  "Which applications need attention?",
];

export default function AiCopilotPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(message: string, confirmedToolCall?: { tool: string; args: Record<string, unknown> }) {
    if (!message.trim() && !confirmedToolCall) return;
    setLoading(true);
    if (!confirmedToolCall) {
      setMessages((prev) => [...prev, { role: "user", content: message }]);
      setInput("");
    }
    try {
      const res = await fetch("/api/ai/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message, confirmedToolCall }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.error ?? "Something went wrong." }]);
        return;
      }
      setConversationId(data.conversationId);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply, toolCalls: data.toolCalls, pendingApproval: data.pendingApproval },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-6.5rem)] max-w-3xl flex-col">
      <div className="flex items-center gap-2 pb-3">
        <Bot className="h-5 w-5" />
        <h1 className="text-lg font-semibold text-slate-900">AI Recruiter Copilot</h1>
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Bot className="h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">Ask me anything about your jobs, candidates, or applications.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-4">
          {messages.map((m, i) => (
            <div key={i} className={cn("flex gap-2", m.role === "user" && "flex-row-reverse")}>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100">
                {m.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </div>
              <div className={cn("flex max-w-[80%] flex-col gap-2", m.role === "user" && "items-end")}>
                <div className={cn("rounded-lg px-3 py-2 text-sm", m.role === "user" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800")}>
                  {m.content}
                </div>
                {!!m.toolCalls?.length && (
                  <div className="flex flex-col gap-1.5">
                    {m.toolCalls.map((tc, ti) => (
                      <ToolResultCard key={ti} toolCall={tc} />
                    ))}
                  </div>
                )}
                {m.pendingApproval && (
                  <Card className="w-full">
                    <CardContent className="flex flex-col gap-2 p-3">
                      <p className="text-xs text-slate-600">
                        Confirm action: <span className="font-medium">{m.pendingApproval.tool}</span>
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => send("", m.pendingApproval)} disabled={loading}>
                          Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setMessages((prev) => prev.map((msg, idx) => (idx === i ? { ...msg, pendingApproval: undefined } : msg)))}>
                          Cancel
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          ))}
          {loading && <div className="text-xs text-slate-400">Copilot is thinking…</div>}
        </div>
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="mt-3 flex gap-2"
      >
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask the copilot…" disabled={loading} />
        <Button type="submit" disabled={loading || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

function ToolResultCard({ toolCall }: { toolCall: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="w-full">
      <CardContent className="p-3">
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-xs font-medium text-slate-600">
          <Wrench className="h-3.5 w-3.5" />
          {toolCall.tool}
        </button>
        {open && (
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-600">
            {JSON.stringify(toolCall.result, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
