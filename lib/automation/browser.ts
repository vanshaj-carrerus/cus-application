import { chromium, type Browser, type BrowserContext } from "playwright";
import type { JobBoard } from "@/lib/models/enums";
import { JobBoardCredential } from "@/lib/models/JobBoardCredential";
import { encryptSecret, decryptSecret } from "@/lib/security/crypto";
import { Types } from "mongoose";

const BOARD_HOSTNAMES: Record<Exclude<JobBoard, "OTHER">, string[]> = {
  LINKEDIN: ["linkedin.com"],
  INDEED: ["indeed.com"],
  NAUKRI: ["naukri.com"],
  DICE: ["dice.com"],
  GLASSDOOR: ["glassdoor.com"],
  MONSTER: ["monster.com"],
  ZIPRECRUITER: ["ziprecruiter.com"],
};

/** Best-effort mapping from an application URL's host to one of our known job boards. */
export function detectBoardFromUrl(url: string): JobBoard | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [board, hostnames] of Object.entries(BOARD_HOSTNAMES)) {
      if (hostnames.some((h) => host.endsWith(h))) return board as JobBoard;
    }
  } catch {
    // ignore malformed URLs, fall through to undefined
  }
  return undefined;
}

export interface ApplySession {
  browser: Browser;
  context: BrowserContext;
  credentialId?: Types.ObjectId;
}

/**
 * Opens a browser context for an apply run. If the candidate has a stored session
 * (cookies) for the detected board, it's restored so we don't need to re-authenticate.
 * Most direct-ATS apply forms (Greenhouse/Lever/Workday/Taleo postings) need no login
 * at all — this only matters for board-gated flows (e.g. LinkedIn Easy Apply).
 */
export async function openApplySession(candidateId: string, board: JobBoard | undefined): Promise<ApplySession> {
  const browser = await chromium.launch();

  if (!board) {
    return { browser, context: await browser.newContext() };
  }

  const credential = await JobBoardCredential.findOne({ candidateId, board }).select("+sessionCookiesEncrypted");
  if (!credential?.sessionCookiesEncrypted) {
    return { browser, context: await browser.newContext() };
  }

  try {
    const storageState = JSON.parse(decryptSecret(credential.sessionCookiesEncrypted));
    return { browser, context: await browser.newContext({ storageState }), credentialId: credential._id as Types.ObjectId };
  } catch {
    // Corrupt/stale session — fall back to a fresh context rather than failing the run.
    return { browser, context: await browser.newContext(), credentialId: credential._id as Types.ObjectId };
  }
}

/** Persists the context's cookies/localStorage back to the credential for reuse next run. */
export async function persistSession(session: ApplySession): Promise<void> {
  if (!session.credentialId) return;
  const storageState = await session.context.storageState();
  await JobBoardCredential.updateOne(
    { _id: session.credentialId },
    { $set: { sessionCookiesEncrypted: encryptSecret(JSON.stringify(storageState)), lastUsedAt: new Date() } }
  );
}

export async function closeApplySession(session: ApplySession): Promise<void> {
  await session.context.close();
  await session.browser.close();
}
