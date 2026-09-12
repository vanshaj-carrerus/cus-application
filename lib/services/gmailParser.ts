import type { gmail_v1 } from "googleapis";

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function findBody(part: gmail_v1.Schema$MessagePart | undefined, preferredMimeType: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === preferredMimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = findBody(child, preferredMimeType);
    if (found) return found;
  }
  return undefined;
}

export interface ParsedGmailMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  from: string;
  to: string[];
  subject: string;
  snippet?: string;
  bodyText: string;
  sentAt: Date;
}

export function parseGmailMessage(message: gmail_v1.Schema$Message): ParsedGmailMessage {
  const headers = message.payload?.headers ?? [];
  const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const html = findBody(message.payload, "text/html");
  const text = html ?? findBody(message.payload, "text/plain") ?? "";

  const toHeader = getHeader("To");
  const dateHeader = getHeader("Date");

  return {
    gmailMessageId: message.id ?? "",
    gmailThreadId: message.threadId ?? "",
    from: getHeader("From"),
    to: toHeader ? toHeader.split(",").map((s) => s.trim()) : [],
    subject: getHeader("Subject"),
    snippet: message.snippet ?? undefined,
    bodyText: text,
    sentAt: dateHeader ? new Date(dateHeader) : new Date(Number(message.internalDate ?? Date.now())),
  };
}

/** Extracts the bare email address from a "Display Name <addr@host>" header value. */
export function extractEmailAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).trim().toLowerCase();
}
