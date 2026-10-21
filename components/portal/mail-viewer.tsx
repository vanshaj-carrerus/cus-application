"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertOctagon, ChevronLeft, FileText, Inbox, Mail, Paperclip, RefreshCw, Search, Send, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildMailFrameDoc, MAIL_FRAME_SANDBOX } from "@/lib/mail/mailFrame";

type Folder = "INBOX" | "SENT" | "DRAFT" | "STARRED" | "SPAM" | "TRASH" | "ALL";

const FOLDERS: Array<{ id: Folder; label: string; icon: typeof Inbox }> = [
  { id: "INBOX", label: "Inbox", icon: Inbox },
  { id: "STARRED", label: "Starred", icon: Star },
  { id: "SENT", label: "Sent", icon: Send },
  { id: "DRAFT", label: "Drafts", icon: FileText },
  { id: "ALL", label: "All mail", icon: Mail },
  { id: "SPAM", label: "Spam", icon: AlertOctagon },
  { id: "TRASH", label: "Trash", icon: Trash2 },
];

interface ListItem {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
}

interface Attachment {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface FullMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  html: string | null;
  text: string | null;
  attachments: Attachment[];
}

/** "Display Name <addr@host>" -> "Display Name" (or the bare address). */
function displayName(headerValue: string): string {
  const name = headerValue.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  return name || headerValue.replace(/[<>]/g, "").trim() || "(unknown)";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/**
 * Renders untrusted email HTML in a sandboxed frame: no scripts, no forms, and a CSP that blocks
 * every network request except (optionally) images. Remote images are off by default because a
 * tracking pixel would tell the sender the mail was opened.
 */
function MailBody({ html, text, allowImages }: { html: string | null; text: string | null; allowImages: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const srcDoc = useMemo(() => buildMailFrameDoc(html, text, allowImages), [html, text, allowImages]);

  const resize = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.max(120, doc.documentElement.scrollHeight + 8));
  }, []);

  return (
    <iframe
      ref={frame}
      title="Email content"
      // allow-same-origin only so the parent can measure the height; with no allow-scripts nothing in the mail can run.
      sandbox={MAIL_FRAME_SANDBOX}
      srcDoc={srcDoc}
      onLoad={resize}
      style={{ height }}
      className="w-full rounded border-0 bg-white"
    />
  );
}

export function MailViewer() {
  const [folder, setFolder] = useState<Folder>("INBOX");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [items, setItems] = useState<ListItem[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<FullMessage | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [allowImages, setAllowImages] = useState(false);

  // A stale response (user clicked another folder/message meanwhile) must not overwrite a newer one.
  const listRequest = useRef(0);
  const messageRequest = useRef(0);

  const loadList = useCallback(async (f: Folder, q: string, pageToken?: string) => {
    const request = ++listRequest.current;
    setListLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({ folder: f });
      if (q) params.set("q", q);
      if (pageToken) params.set("pageToken", pageToken);
      const data = await getJson<{ messages: ListItem[]; nextPageToken: string | null }>(`/api/portal/gmail/messages?${params}`);
      if (request !== listRequest.current) return;
      setItems((prev) => (pageToken ? [...prev, ...data.messages] : data.messages));
      setNextToken(data.nextPageToken);
    } catch (err) {
      if (request !== listRequest.current) return;
      setListError(err instanceof Error ? err.message : "Couldn't load mail");
      if (!pageToken) setItems([]);
      setNextToken(null);
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load a folder when it (or the search) changes
    loadList(folder, activeQuery);
  }, [folder, activeQuery, loadList]);

  async function openMessage(id: string) {
    setSelectedId(id);
    setAllowImages(false);
    setMessage(null);
    setMessageError(null);
    setMessageLoading(true);
    const request = ++messageRequest.current;
    try {
      const data = await getJson<{ message: FullMessage }>(`/api/portal/gmail/messages/${id}`);
      if (request === messageRequest.current) setMessage(data.message);
    } catch (err) {
      if (request === messageRequest.current) setMessageError(err instanceof Error ? err.message : "Couldn't open this message");
    } finally {
      if (request === messageRequest.current) setMessageLoading(false);
    }
  }

  function changeFolder(f: Folder) {
    setFolder(f);
    setSelectedId(null);
    setMessage(null);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setSelectedId(null);
    setMessage(null);
    setActiveQuery(query.trim());
  }

  const showFromColumn = folder !== "SENT" && folder !== "DRAFT";
  const readingOnMobile = selectedId !== null;

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[32rem] overflow-hidden rounded-lg border border-slate-200 bg-white">
      {/* Folders */}
      <nav className="hidden w-44 shrink-0 flex-col gap-0.5 border-r border-slate-200 bg-slate-50 p-2 md:flex" aria-label="Mail folders">
        {FOLDERS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => changeFolder(id)}
            className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm", folder === id ? "bg-slate-200 font-medium text-slate-900" : "text-slate-600 hover:bg-slate-100")}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      {/* Message list */}
      <section className={cn("flex min-w-0 flex-col border-r border-slate-200 md:w-96 md:shrink-0", readingOnMobile ? "hidden md:flex" : "flex w-full")}>
        <div className="flex flex-col gap-2 border-b border-slate-200 p-2">
          <select
            value={folder}
            onChange={(e) => changeFolder(e.target.value as Folder)}
            className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm md:hidden"
            aria-label="Folder"
          >
            {FOLDERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <form onSubmit={submitSearch} className="flex gap-1">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-slate-400" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mail (e.g. from:linkedin)" className="pl-8" />
            </div>
            <Button type="button" variant="ghost" size="icon" title="Refresh" onClick={() => loadList(folder, activeQuery)} disabled={listLoading}>
              <RefreshCw className={cn(listLoading && "animate-spin")} />
            </Button>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto">
          {listError ? (
            <p className="p-4 text-sm text-red-600">{listError}</p>
          ) : listLoading && items.length === 0 ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">{activeQuery ? "No messages match that search." : "Nothing here."}</p>
          ) : (
            <ul>
              {items.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => openMessage(m.id)}
                    className={cn("flex w-full flex-col gap-0.5 border-b border-slate-100 px-3 py-2.5 text-left hover:bg-slate-50", selectedId === m.id && "bg-blue-50 hover:bg-blue-50")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("truncate text-sm", m.unread ? "font-semibold text-slate-900" : "text-slate-700")}>
                        {showFromColumn ? displayName(m.from) : folder === "DRAFT" ? `Draft — ${m.to ? displayName(m.to) : "no recipient"}` : `To: ${displayName(m.to)}`}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                        {m.starred && <Star className="size-3 fill-amber-400 text-amber-400" />}
                        {m.hasAttachments && <Paperclip className="size-3" />}
                        {shortDate(m.date)}
                      </span>
                    </div>
                    <span className={cn("truncate text-sm", m.unread ? "font-medium text-slate-900" : "text-slate-600")}>{m.subject || "(no subject)"}</span>
                    <span className="truncate text-xs text-slate-400">{m.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {nextToken && !listError && (
            <div className="p-3">
              <Button variant="outline" size="sm" className="w-full" disabled={listLoading} onClick={() => loadList(folder, activeQuery, nextToken)}>
                {listLoading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Reading pane */}
      <section className={cn("min-w-0 flex-1 flex-col overflow-y-auto", readingOnMobile ? "flex" : "hidden md:flex")}>
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-slate-400">Select a message to read it</div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <Button variant="ghost" size="sm" className="w-fit md:hidden" onClick={() => setSelectedId(null)}>
              <ChevronLeft /> Back
            </Button>
            {messageLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-7 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : messageError ? (
              <p className="text-sm text-red-600">{messageError}</p>
            ) : message ? (
              <>
                <h2 className="text-lg font-semibold text-slate-900">{message.subject || "(no subject)"}</h2>
                <div className="flex flex-col gap-0.5 border-b border-slate-100 pb-3 text-xs text-slate-500">
                  <div>
                    <span className="font-medium text-slate-700">From:</span> {message.from}
                  </div>
                  <div>
                    <span className="font-medium text-slate-700">To:</span> {message.to || "—"}
                  </div>
                  {message.cc && (
                    <div>
                      <span className="font-medium text-slate-700">Cc:</span> {message.cc}
                    </div>
                  )}
                  <div>{new Date(message.date).toLocaleString()}</div>
                </div>

                {message.html && !allowImages && (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    Images are hidden so the sender can&apos;t tell you opened this message.
                    <Button variant="outline" size="sm" onClick={() => setAllowImages(true)}>
                      Show images
                    </Button>
                  </div>
                )}

                <MailBody html={message.html} text={message.text} allowImages={allowImages} />

                {message.attachments.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
                    <div className="text-xs font-medium text-slate-600">{message.attachments.length} attachment{message.attachments.length > 1 ? "s" : ""}</div>
                    <div className="flex flex-wrap gap-2">
                      {message.attachments.map((a) => (
                        <a
                          key={a.partId}
                          href={`/api/portal/gmail/messages/${message.id}/attachments/${a.partId}`}
                          className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <Paperclip className="size-3.5" />
                          {a.filename}
                          <span className="text-slate-400">{formatSize(a.size)}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
