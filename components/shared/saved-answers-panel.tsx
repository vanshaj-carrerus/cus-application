"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Answer {
  _id: string;
  question: string;
  answer: string;
  status: "ANSWERED" | "NEEDED";
  source: "STAFF" | "CANDIDATE" | "BOT";
  options?: string[];
  askedOn?: string;
  required?: boolean;
  timesUsed: number;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/**
 * Answers to the questions application forms ask. The bot fills these in itself, and when it meets a required
 * question it can't answer it adds it here — so each question is answered once, by a person, and never guessed.
 * `retryUrl` (recruiters only) re-runs the applications that were waiting on missing answers.
 */
export function SavedAnswersPanel({ baseUrl, retryUrl, audience }: { baseUrl: string; retryUrl?: string; audience: "staff" | "candidate" }) {
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await call<{ answers: Answer[] }>(baseUrl);
      setAnswers(d.answers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load answers");
    }
  }, [baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const needed = (answers ?? []).filter((a) => a.status === "NEEDED");
  const done = (answers ?? []).filter((a) => a.status === "ANSWERED");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved answers</CardTitle>
        <p className="text-xs text-slate-500">
          {audience === "staff"
            ? "Answers the auto-apply bot uses on application forms. When it hits a required question it can't answer, it is listed below — answer it once and it's used on every form that asks."
            : "Answers we use when an employer's application form asks a question. If the bot is missing one, it appears below — please answer it so your applications can continue."}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!answers ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {needed.length > 0 && (
              <div className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="text-sm font-medium text-amber-900">{needed.length} question{needed.length > 1 ? "s" : ""} waiting for an answer</div>
                {needed.map((a) => (
                  <div key={a._id} className="flex flex-col gap-1.5">
                    <div className="text-sm text-slate-900">
                      {a.question}{" "}
                      <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${a.required ? "bg-red-100 text-red-700" : "bg-slate-200 text-slate-600"}`}>{a.required ? "Required" : "Optional"}</span>
                    </div>
                    {a.askedOn && <div className="text-xs text-slate-500">Asked on {a.askedOn}</div>}
                    <div className="flex gap-2">
                      {a.options?.length ? (
                        <select className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm" value={drafts[a._id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [a._id]: e.target.value }))}>
                          <option value="">Choose an answer…</option>
                          {a.options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input className="flex-1" placeholder="Your answer" value={drafts[a._id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [a._id]: e.target.value }))} />
                      )}
                      <Button size="sm" disabled={!drafts[a._id]?.trim() || busy === a._id} onClick={() => run(a._id, () => call(`${baseUrl}/${a._id}`, { method: "PATCH", body: JSON.stringify({ answer: drafts[a._id] }) }))}>
                        {busy === a._id ? "Saving…" : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy === a._id} title={a.required ? "This question doesn't apply: remove it" : "Optional: skip it, applications go on without an answer"} onClick={() => run(a._id, () => call(`${baseUrl}/${a._id}`, { method: "DELETE" }))}>
                        Skip
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {retryUrl && needed.length === 0 && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === "retry"}
                  onClick={() =>
                    run("retry", async () => {
                      const r = await call<{ queued: number }>(retryUrl, { method: "POST" });
                      setRetryMessage(r.queued > 0 ? `Re-queued ${r.queued} application${r.queued > 1 ? "s" : ""} that were waiting on these answers.` : "No applications were waiting on missing answers.");
                    })
                  }
                >
                  {busy === "retry" ? "Re-queuing…" : "Re-run applications that were waiting"}
                </Button>
                {retryMessage && <span className="text-xs text-emerald-700">{retryMessage}</span>}
              </div>
            )}

            {done.length === 0 && needed.length === 0 && <p className="text-sm text-slate-500">No saved answers yet.</p>}

            {done.length > 0 && (
              <ul className="flex flex-col divide-y divide-slate-100">
                {done.map((a) => (
                  <li key={a._id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm text-slate-900">
                      {a.question}{" "}
                      <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${a.required ? "bg-red-100 text-red-700" : "bg-slate-200 text-slate-600"}`}>{a.required ? "Required" : "Optional"}</span>
                    </div>
                      <div className="mt-0.5 break-words text-sm text-slate-600">{a.answer}</div>
                      <div className="mt-0.5 flex gap-2 text-xs text-slate-400">
                        <span>{a.source === "CANDIDATE" ? "by the candidate" : a.source === "STAFF" ? "by a recruiter" : "by the bot"}</span>
                        {a.timesUsed > 0 && <Badge variant="secondary">used {a.timesUsed}×</Badge>}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" disabled={busy === a._id} onClick={() => run(a._id, () => call(`${baseUrl}/${a._id}`, { method: "DELETE" }))}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
              <div className="text-xs font-medium text-slate-600">Add an answer</div>
              <Input placeholder="Question as it appears on forms, e.g. Are you authorized to work in the US?" value={newQuestion} onChange={(e) => setNewQuestion(e.target.value)} />
              <div className="flex gap-2">
                <Input className="flex-1" placeholder="Answer" value={newAnswer} onChange={(e) => setNewAnswer(e.target.value)} />
                <Button
                  size="sm"
                  disabled={newQuestion.trim().length < 4 || !newAnswer.trim() || busy === "add"}
                  onClick={() =>
                    run("add", async () => {
                      await call(baseUrl, { method: "POST", body: JSON.stringify({ question: newQuestion, answer: newAnswer }) });
                      setNewQuestion("");
                      setNewAnswer("");
                    })
                  }
                >
                  {busy === "add" ? "Adding…" : "Add"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
