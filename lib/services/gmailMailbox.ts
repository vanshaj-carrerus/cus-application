import type { gmail_v1 } from "googleapis";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";

/**
 * Read-only mailbox browsing for the account owner (candidate portal "Email Access").
 * Uses the gmail.readonly scope the connection already holds — nothing here can send, modify,
 * label or delete, and nothing is stored: every call reads straight from Gmail.
 */

export const MAILBOX_FOLDERS = ["INBOX", "SENT", "DRAFT", "STARRED", "SPAM", "TRASH", "ALL"] as const;
export type MailboxFolder = (typeof MAILBOX_FOLDERS)[number];

export function isMailboxFolder(value: string): value is MailboxFolder {
  return (MAILBOX_FOLDERS as readonly string[]).includes(value);
}

const PAGE_SIZE = 25;
const METADATA_CONCURRENCY = 8;

export interface MailListItem {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
}

export interface MailAttachment {
  /** Position of the part in the message — stable across fetches, unlike Gmail's attachmentId. */
  partId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  labelIds: string[];
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
}

/** A connected mailbox for this candidate, or a typed error the route can turn into a clear message. */
export async function getCandidateMailbox(candidateId: string) {
  const account = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: candidateId });
  if (!account) throw httpError(404, "Gmail not connected");
  if (account.status === "DISCONNECTED") throw httpError(409, "Gmail is disconnected — reconnect it to browse your mailbox");
  const { gmail } = await getAuthenticatedGmailClient(String(account._id));
  return { gmail, account };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/** Maps a Google API failure to something the person can act on. */
export function translateGoogleError(err: unknown): never {
  const e = err as { code?: number; status?: number; message?: string; response?: { status?: number } };
  const status = e.code ?? e.status ?? e.response?.status;
  const msg = e.message ?? "";
  if (status === 401 || /invalid_grant|invalid_credentials|unauthorized_client/i.test(msg)) {
    throw httpError(401, "Google no longer allows access to this mailbox — disconnect and connect it again");
  }
  if (status === 403 && /insufficient|scope/i.test(msg)) {
    throw httpError(403, "This connection doesn't have permission to read mail — disconnect and connect it again, accepting every permission");
  }
  if (status === 404 || (status === 400 && /invalid id/i.test(msg))) throw httpError(404, "That message no longer exists");
  if (status === 429) throw httpError(429, "Gmail is rate-limiting requests — try again in a minute");
  throw err;
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function dateOf(message: gmail_v1.Schema$Message): string {
  const internal = Number(message.internalDate);
  return new Date(Number.isFinite(internal) && internal > 0 ? internal : Date.now()).toISOString();
}

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function hasAttachment(part: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!part) return false;
  if (part.filename && part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachment);
}

export async function listMailbox(
  gmail: gmail_v1.Gmail,
  opts: { folder: MailboxFolder; q?: string; pageToken?: string }
): Promise<{ messages: MailListItem[]; nextPageToken: string | null }> {
  const labelIds = opts.folder === "ALL" ? undefined : [opts.folder];
  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults: PAGE_SIZE,
    labelIds,
    q: opts.q?.trim() || undefined,
    pageToken: opts.pageToken || undefined,
    // Spam and Trash are hidden from "All mail" and from searches unless asked for.
    includeSpamTrash: opts.folder === "SPAM" || opts.folder === "TRASH",
  });

  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  const messages = await inChunks(ids, METADATA_CONCURRENCY, async (id): Promise<MailListItem | null> => {
    try {
      // "full" (not "metadata") so attachments can be flagged; the body is dropped before returning.
      const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const m = res.data;
      const h = m.payload?.headers;
      return {
        id: m.id ?? id,
        threadId: m.threadId ?? "",
        from: header(h, "From"),
        to: header(h, "To"),
        subject: header(h, "Subject"),
        snippet: m.snippet ?? "",
        date: dateOf(m),
        unread: (m.labelIds ?? []).includes("UNREAD"),
        starred: (m.labelIds ?? []).includes("STARRED"),
        hasAttachments: hasAttachment(m.payload),
      };
    } catch {
      return null; // a message deleted between list and get — just skip it
    }
  });

  return { messages: messages.filter((m): m is MailListItem => m !== null), nextPageToken: list.data.nextPageToken ?? null };
}

/** Decodes a body part using the charset its Content-Type declares (Gmail returns the raw bytes). */
function decodePart(part: gmail_v1.Schema$MessagePart): string {
  const bytes = Buffer.from(part.body?.data ?? "", "base64url");
  const charset = header(part.headers, "Content-Type").match(/charset="?([\w-]+)"?/i)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf-8");
  }
}

function collect(part: gmail_v1.Schema$MessagePart | undefined, found: { html?: string; text?: string; attachments: MailAttachment[] }) {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    found.attachments.push({ partId: part.partId ?? "", attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body.size ?? 0 });
  } else if (part.body?.data) {
    if (part.mimeType === "text/html" && found.html === undefined) found.html = decodePart(part);
    else if (part.mimeType === "text/plain" && found.text === undefined) found.text = decodePart(part);
  }
  for (const child of part.parts ?? []) collect(child, found);
}

export async function readMessage(gmail: gmail_v1.Gmail, id: string): Promise<MailMessage> {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const m = res.data;
  const h = m.payload?.headers;
  const found: { html?: string; text?: string; attachments: MailAttachment[] } = { attachments: [] };
  collect(m.payload, found);
  return {
    id: m.id ?? id,
    threadId: m.threadId ?? "",
    from: header(h, "From"),
    to: header(h, "To"),
    cc: header(h, "Cc"),
    subject: header(h, "Subject"),
    date: dateOf(m),
    labelIds: m.labelIds ?? [],
    html: found.html ?? null,
    text: found.text ?? null,
    attachments: found.attachments,
  };
}

export async function readAttachment(gmail: gmail_v1.Gmail, messageId: string, partId: string): Promise<{ data: Buffer; filename: string; mimeType: string }> {
  // Take the filename/type from the message itself rather than trusting the request's query string.
  const message = await readMessage(gmail, messageId);
  const meta = message.attachments.find((a) => a.partId === partId);
  if (!meta) throw httpError(404, "Attachment not found on that message");

  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: meta.attachmentId });
  return { data: Buffer.from(res.data.data ?? "", "base64url"), filename: meta.filename, mimeType: meta.mimeType };
}
