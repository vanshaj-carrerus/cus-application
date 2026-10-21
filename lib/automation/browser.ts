import { chromium, type Browser, type BrowserContext } from "playwright";
import { installCaptchaCapture } from "@/lib/automation/captcha";
import { connectRemoteBrowser } from "@/lib/automation/remoteProxyBrowser";
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
/** True when the residential remote browser is configured, so a blocked run can be retried through it. */
export function remoteBrowserAvailable(): boolean {
  return !!process.env.BRIGHT_DATA_PASSWORD;
}

export async function openApplySession(candidateId: string, board: JobBoard | undefined, options: { remote?: boolean } = {}): Promise<ApplySession> {
  // The remote residential browser (see remoteProxyBrowser.ts) is for sites whose bot check rejects our own
  // browser's address. It is used when APPLY_REMOTE_BROWSER=true, or per run when the engine escalates a
  // run that the site blocked. It reuses the remote default context, so a saved board login is restored by
  // adding its cookies to that context.
  if (options.remote || process.env.APPLY_REMOTE_BROWSER === "true") {
    const remote = await connectRemoteBrowser();
    const context = remote.contexts()[0] ?? (await remote.newContext());
    await installCaptchaCapture(context);
    let credentialId: Types.ObjectId | undefined;
    if (board) {
      const credential = await JobBoardCredential.findOne({ candidateId, board }).select("+sessionCookiesEncrypted");
      if (credential?.sessionCookiesEncrypted) {
        credentialId = credential._id as Types.ObjectId;
        try {
          const state = JSON.parse(decryptSecret(credential.sessionCookiesEncrypted)) as { cookies?: Parameters<BrowserContext["addCookies"]>[0] };
          if (state.cookies?.length) await context.addCookies(state.cookies);
        } catch {
          // a stale or corrupt saved session just means starting signed out
        }
      }
    }
    return { browser: remote, context, credentialId };
  }

  const browser = await chromium.launch();

  // Every context records Cloudflare/Turnstile challenge parameters before page scripts run
  // (see installCaptchaCapture) so a "Just a moment…" page can be handed to the solver later.
  const newContext = async (options?: Parameters<Browser["newContext"]>[0]) => {
    const context = await browser.newContext(options);
    await installCaptchaCapture(context);
    return context;
  };

  if (!board) {
    return { browser, context: await newContext() };
  }

  const credential = await JobBoardCredential.findOne({ candidateId, board }).select("+sessionCookiesEncrypted");
  if (!credential?.sessionCookiesEncrypted) {
    return { browser, context: await newContext() };
  }

  try {
    const storageState = JSON.parse(decryptSecret(credential.sessionCookiesEncrypted));
    return { browser, context: await newContext({ storageState }), credentialId: credential._id as Types.ObjectId };
  } catch {
    // Corrupt/stale session — fall back to a fresh context rather than failing the run.
    return { browser, context: await newContext(), credentialId: credential._id as Types.ObjectId };
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

/**
 * Remembers a signed-in job-board session (cookies + local storage) for this candidate, creating the
 * board's credential if there isn't one yet. The next apply run restores it in openApplySession and
 * starts already signed in, so the board's login — and any bot check that comes with it — happens once
 * instead of on every application.
 */
export async function saveBoardSession(candidateId: string, board: JobBoard, context: BrowserContext, loginId: string, password: string): Promise<void> {
  if (board === "OTHER") return;
  const storageState = await context.storageState();
  const set: Record<string, unknown> = {
    sessionCookiesEncrypted: encryptSecret(JSON.stringify(storageState)),
    status: "ACTIVE",
    lastUsedAt: new Date(),
    lastVerifiedAt: new Date(),
  };
  const existing = await JobBoardCredential.findOne({ candidateId, board }).select("_id");
  if (existing) {
    await JobBoardCredential.updateOne({ _id: existing._id }, { $set: set, $unset: { lastError: 1 } });
    return;
  }
  if (!loginId || !password) return; // a credential row needs both; without them there is nothing valid to create
  await JobBoardCredential.create({ candidateId, board, boardUsername: loginId, passwordEncrypted: encryptSecret(password), ...set });
}

export async function closeApplySession(session: ApplySession): Promise<void> {
  await session.context.close();
  await session.browser.close();
}
