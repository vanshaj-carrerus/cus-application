import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { parseGmailMessage, extractEmailAddress } from "@/lib/services/gmailParser";

/**
 * Pulls a one-time verification code out of the candidate's *own* OAuth-connected
 * Gmail so the apply flow can clear an email-verification step end to end. This is
 * only ever the account owner (via the agent they authorized at /portal/gmail)
 * reading their own inbox for their own code — it does not touch any mailbox the
 * candidate hasn't explicitly connected. See lib/automation/authLogin.ts for the
 * page-side fill/submit that consumes this.
 */

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 90_000;

/** Rough eTLD+1 so a code from "no-reply@mail.greenhouse.io" matches host "boards.greenhouse.io". */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts a verification code, preferring digits that sit next to a code-ish word
 * so we don't grab an unrelated number (an order total, a year, a phone number).
 */
export function extractVerificationCode(subject: string, body: string): string | null {
  const text = `${subject}\n${stripHtml(body)}`;

  const keyworded = /(?:code|otp|verification|verify|passcode|one[-\s]?time|pin|token)\D{0,40}?\b([0-9]{4,8})\b/i;
  const km = text.match(keyworded);
  if (km) return km[1];

  // Alphanumeric codes, but only when they carry at least one digit (avoids matching words).
  const keywordedAlnum = /(?:code|otp|verification|passcode)\D{0,30}?\b([A-Z0-9]{5,8})\b/;
  const am = text.match(keywordedAlnum);
  if (am && /[0-9]/.test(am[1])) return am[1];

  // Last resort: a lone 6-digit code in the subject line ("123456 is your code").
  const six = subject.match(/\b(\d{6})\b/);
  return six ? six[1] : null;
}

export interface OtpFetchResult {
  code: string | null;
  from?: string;
  subject?: string;
}

/**
 * Polls the candidate's connected inbox for a verification code that arrived after
 * `since` (the moment we triggered the signup/login). Prefers a message whose sender
 * domain matches the portal; otherwise falls back to the newest code-bearing message
 * in the window. Returns `{ code: null }` if no connected mailbox exists or none
 * arrives before the timeout.
 */
export async function fetchVerificationCode(opts: {
  candidateId: string;
  targetHost: string;
  since: Date;
  timeoutMs?: number;
}): Promise<OtpFetchResult> {
  const { candidateId, targetHost, since } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const account = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: candidateId });
  if (!account) return { code: null };

  const { gmail } = await getAuthenticatedGmailClient(String(account._id));
  const targetDomain = registrableDomain(targetHost);
  const afterEpoch = Math.floor(since.getTime() / 1000);
  const query = `after:${afterEpoch} (code OR verification OR verify OR otp OR "one-time" OR passcode OR confirm)`;

  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  let fallback: OtpFetchResult | null = null;

  while (Date.now() < deadline) {
    const list = await gmail.users.messages
      .list({ userId: "me", q: query, maxResults: 10 })
      .catch(() => null);

    for (const { id } of list?.data.messages ?? []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" }).catch(() => null);
      if (!full?.data) continue;

      const parsed = parseGmailMessage(full.data);
      if (parsed.sentAt.getTime() < since.getTime()) continue;

      const code = extractVerificationCode(parsed.subject, parsed.bodyText);
      if (!code) continue;

      const fromAddr = extractEmailAddress(parsed.from);
      const fromDomain = registrableDomain((fromAddr.split("@")[1] ?? ""));

      // A sender-domain match is the trustworthy signal — take it immediately.
      if (fromDomain && fromDomain === targetDomain) {
        return { code, from: fromAddr, subject: parsed.subject };
      }
      // Otherwise remember the first code-bearing mail and keep looking for a match.
      fallback ??= { code, from: fromAddr, subject: parsed.subject };
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return fallback ?? { code: null };
}
