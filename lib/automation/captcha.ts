import type { BrowserContext, Page } from "playwright";
import { env } from "@/lib/env";

/* ────────────────────────────────────────────────────────────────────────────
 * CAPTCHA Detection
 * ────────────────────────────────────────────────────────────────────────── */

/** The type of CAPTCHA detected on the page, or null if none found. */
export type CaptchaType = "RECAPTCHA_V2" | "HCAPTCHA" | "TURNSTILE" | "UNKNOWN";

export interface CaptchaDetection {
  detected: boolean;
  type: CaptchaType | null;
  siteKey: string | null;
  iframeUrl: string | null;
  /** Invisible widgets have no checkbox; they fire on form submit. */
  invisible: boolean;
  enterprise: boolean;
  /** The widget's response field already holds a token (solved by us or organically). */
  tokenPresent: boolean;
  /** Full-page Cloudflare interstitial ("Just a moment…"), not a widget embedded in a form. */
  challengePage: boolean;
  /** Cloudflare "you have been blocked" page: nothing on it can be solved. */
  hardBlock: boolean;
}

const NOT_DETECTED: CaptchaDetection = {
  detected: false,
  type: null,
  siteKey: null,
  iframeUrl: null,
  invisible: false,
  enterprise: false,
  tokenPresent: false,
  challengePage: false,
  hardBlock: false,
};

/**
 * Cloudflare's "Just a moment…" interstitial renders its Turnstile with per-visit
 * parameters (cData / chlPageData / action) that 2Captcha needs, and a callback that
 * must be invoked with the solved token. Both only exist inside the page's own
 * `turnstile.render()` call, so this wraps it — before any page script runs — and stashes
 * the arguments on window.__cusTurnstile. The original render still runs, so pages behave
 * exactly as before (an interstitial that passes on its own still passes).
 */
const CAPTURE_INIT_SCRIPT = `(() => {
  if (window.__cusCaptureInstalled) return;
  window.__cusCaptureInstalled = true;
  const wrap = (ts) => {
    if (!ts || typeof ts !== 'object' || ts.__cusWrapped || typeof ts.render !== 'function') return ts;
    const orig = ts.render;
    try {
      ts.render = function (el, opts) {
        try {
          if (opts && typeof opts === 'object') {
            window.__cusTurnstile = { sitekey: opts.sitekey, action: opts.action, cData: opts.cData, chlPageData: opts.chlPageData, callback: opts.callback, at: Date.now() };
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      ts.__cusWrapped = true;
    } catch (e) {}
    return ts;
  };
  // Polling (not a defineProperty accessor on window): Cloudflare's challenge script behaves
  // differently when window.turnstile is tampered with, and never creates it.
  const timer = setInterval(() => {
    if (window.turnstile) {
      wrap(window.turnstile);
      if (window.turnstile.__cusWrapped) clearInterval(timer);
    }
  }, 10);
  setTimeout(() => clearInterval(timer), 60000);
})();`;

/** Must be called on every browser context before navigating (see browser.ts). */
export async function installCaptchaCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript(CAPTURE_INIT_SCRIPT);
}

// reCAPTCHA tokens expire ~120s after they're issued; leave a margin so a token we
// injected is never trusted when it is about to go stale (e.g. a long form fill).
const TOKEN_TTL_MS = 100_000;
const tokenInjectedAt = new WeakMap<Page, number>();

function hasUsableToken(page: Page, detection: CaptchaDetection): boolean {
  if (!detection.tokenPresent) return false;
  const injectedAt = tokenInjectedAt.get(page);
  return injectedAt === undefined || Date.now() - injectedAt < TOKEN_TTL_MS;
}

/**
 * True when the page shows a CAPTCHA that still needs solving. A widget that already
 * holds a fresh response token does not count — the widget iframe stays in the DOM
 * after a solve, so "iframe exists" alone can't be used as the signal.
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  const detection = await detectCaptchaDetails(page);
  return detection.detected && !hasUsableToken(page, detection);
}

export async function detectCaptchaDetails(page: Page): Promise<CaptchaDetection> {
  const scan = await page
    .evaluate(() => {
      // tsx/esbuild wraps named inner functions in a __name() helper that doesn't exist in the browser.
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      const win = window;
      const all = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
      const hasValue = (sel: string) => all(sel).some((el) => ((el as HTMLInputElement).value ?? "").trim().length > 0);
      const query = (src: string) => {
        try {
          return new URL(src, location.href).searchParams;
        } catch {
          return new URLSearchParams();
        }
      };
      const hash = (src: string) => {
        try {
          return new URLSearchParams(new URL(src, location.href).hash.slice(1));
        } catch {
          return new URLSearchParams();
        }
      };

      // --- reCAPTCHA ---
      const rcDiv = all(".g-recaptcha[data-sitekey]")[0];
      const rcFrame = all('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]')[0] as HTMLIFrameElement | undefined;
      // reCAPTCHA v3 loads api.js?render=<sitekey> and shows only a corner badge (an invisible
      // "anchor" iframe). There is nothing to solve on the page — the site scores the session
      // when the form is submitted — so it must not be mistaken for a v2 challenge.
      const v3Render = all('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]')
        .map((s) => query((s as HTMLScriptElement).src).get("render"))
        .find((r) => r && r !== "explicit");
      let recaptcha: { siteKey: string | null; invisible: boolean; enterprise: boolean; src: string | null } | null = null;
      if (rcDiv) {
        recaptcha = {
          siteKey: rcDiv.getAttribute("data-sitekey"),
          invisible: rcDiv.getAttribute("data-size") === "invisible",
          enterprise: !!rcFrame && rcFrame.src.includes("/enterprise/"),
          src: rcFrame?.src ?? null,
        };
      } else if (rcFrame && !v3Render) {
        const q = query(rcFrame.src);
        recaptcha = { siteKey: q.get("k"), invisible: q.get("size") === "invisible", enterprise: rcFrame.src.includes("/enterprise/"), src: rcFrame.src };
      }

      // --- hCaptcha ---
      const hcDiv = all(".h-captcha[data-sitekey]")[0];
      const hcFrame = all('iframe[src*="hcaptcha.com"]')[0] as HTMLIFrameElement | undefined;
      const hcaptcha =
        hcDiv || hcFrame
          ? {
              siteKey: hcDiv?.getAttribute("data-sitekey") ?? (hcFrame ? hash(hcFrame.src).get("sitekey") : null),
              invisible: hcDiv?.getAttribute("data-size") === "invisible",
              src: hcFrame?.src ?? null,
            }
          : null;

      // --- Cloudflare Turnstile ---
      const tsDiv = all(".cf-turnstile[data-sitekey]")[0];
      const tsFrame = all('iframe[src*="challenges.cloudflare.com"]')[0] as HTMLIFrameElement | undefined;
      const turnstile =
        tsDiv || tsFrame
          ? {
              siteKey: tsDiv?.getAttribute("data-sitekey") ?? tsFrame?.src.match(/\/(0x[0-9A-Za-z_-]+)\//)?.[1] ?? null,
              src: tsFrame?.src ?? null,
            }
          : null;

      // Cloudflare interstitial: title is the reliable marker; _cf_chl_opt / #challenge-form
      // exist only on challenge pages (the cdn-cgi/challenge-platform script alone is also
      // loaded on ordinary Cloudflare-fronted sites, so it is NOT used as a signal).
      const captured = (win as unknown as { __cusTurnstile?: { sitekey?: string } }).__cusTurnstile;
      const challengePage =
        /just a moment|checking your browser|verifying you are human/i.test(document.title) ||
        "_cf_chl_opt" in window ||
        !!document.querySelector("#challenge-form, #challenge-running, #challenge-stage");

      // "Attention Required! | Cloudflare" / "Sorry, you have been blocked" (error 1020 etc.):
      // the site refused this IP/browser outright — there is no widget to solve.
      const hardBlock = /attention required.*cloudflare|access denied/i.test(document.title) && /sorry, you have been blocked|cloudflare ray id/i.test(document.body?.innerText ?? "");

      return {
        hardBlock,
        challengePage,
        capturedSiteKey: captured?.sitekey ?? null,
        recaptcha,
        hcaptcha,
        turnstile,
        genericIframe: all('iframe[title*="captcha" i]').length > 0,
        bodyText: document.body?.innerText ?? "",
        tokens: {
          recaptcha: hasValue("textarea[name='g-recaptcha-response'], #g-recaptcha-response"),
          hcaptcha: hasValue("textarea[name='h-captcha-response']"),
          turnstile: hasValue("input[name='cf-turnstile-response']"),
        },
      };
    })
    .catch(() => null);

  if (!scan) return NOT_DETECTED;

  if (scan.hardBlock) {
    return { ...NOT_DETECTED, detected: true, type: "UNKNOWN", hardBlock: true };
  }
  if (scan.challengePage) {
    return { ...NOT_DETECTED, detected: true, type: "TURNSTILE", siteKey: scan.capturedSiteKey ?? scan.turnstile?.siteKey ?? null, iframeUrl: scan.turnstile?.src ?? null, challengePage: true };
  }
  if (scan.recaptcha) {
    return {
      ...NOT_DETECTED,
      detected: true,
      type: "RECAPTCHA_V2",
      siteKey: scan.recaptcha.siteKey,
      iframeUrl: scan.recaptcha.src,
      invisible: scan.recaptcha.invisible,
      enterprise: scan.recaptcha.enterprise,
      tokenPresent: scan.tokens.recaptcha,
    };
  }
  if (scan.hcaptcha) {
    return { ...NOT_DETECTED, detected: true, type: "HCAPTCHA", siteKey: scan.hcaptcha.siteKey, iframeUrl: scan.hcaptcha.src, invisible: scan.hcaptcha.invisible, tokenPresent: scan.tokens.hcaptcha };
  }
  if (scan.turnstile) {
    return { ...NOT_DETECTED, detected: true, type: "TURNSTILE", siteKey: scan.turnstile.siteKey, iframeUrl: scan.turnstile.src, tokenPresent: scan.tokens.turnstile };
  }
  if (scan.genericIframe || /verify (that )?you.{0,15}(human|robot)|complete the captcha/i.test(scan.bodyText)) {
    return { ...NOT_DETECTED, detected: true, type: "UNKNOWN" };
  }

  return NOT_DETECTED;
}

/* ────────────────────────────────────────────────────────────────────────────
 * CAPTCHA Solving
 * ────────────────────────────────────────────────────────────────────────── */

export interface CaptchaSolveResult {
  solved: boolean;
  method: "2captcha" | "checkbox_click" | "ai_vision" | "none";
  message: string;
}

const MAX_SOLVE_ATTEMPTS = 3;
// Every 2Captcha attempt that returns a token is billed, so keep paid retries low.
const MAX_2CAPTCHA_ATTEMPTS = 2;
const SOLVE_FIRST_POLL_DELAY_MS = 15_000; // 2Captcha advises waiting 15–20s before the first poll
const SOLVE_POLL_INTERVAL_MS = 5_000;
const SOLVE_POLL_TIMEOUT_MS = 150_000;
const API_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Attempts to clear the detected CAPTCHA using a tiered strategy:
 *
 * 1. **2Captcha API** — if CAPTCHA_API_KEY is configured and the widget's sitekey is
 *    known, a human/AI worker solves it remotely and we write the returned token into
 *    the page (response field + the widget's callback). Supports reCAPTCHA v2
 *    (checkbox / invisible / enterprise), hCaptcha and Cloudflare Turnstile.
 *
 * 2. **Checkbox click** (fallback) — for reCAPTCHA v2, click the "I'm not a robot"
 *    checkbox. Only works when the session scores as low-risk.
 *
 * 3. **AI vision** (fallback) — screenshot + vision model, best-effort only.
 *
 * Returns whether the CAPTCHA was cleared. The caller (applyEngine.ts) decides whether
 * to continue or hand off to a human based on `result.solved`.
 */
export async function solveCaptcha(page: Page): Promise<CaptchaSolveResult> {
  const detection = await detectCaptchaDetails(page);
  if (!detection.detected) {
    return { solved: true, method: "none", message: "No CAPTCHA detected on re-check" };
  }
  if (hasUsableToken(page, detection)) {
    return { solved: true, method: "none", message: "CAPTCHA already carries a valid response token" };
  }

  if (detection.hardBlock) {
    return {
      solved: false,
      method: "none",
      message: "The site blocked this browser outright (Cloudflare 'you have been blocked' page) — no CAPTCHA to solve; needs a different IP/browser or a human",
    };
  }

  // --- Cloudflare "Just a moment…" interstitial: needs its own parameters, see below ---
  if (detection.challengePage) {
    return solveCloudflareChallenge(page);
  }

  // --- Tier 1: 2Captcha ---
  if (env.captchaApiKey && detection.siteKey) {
    let last: ApiOutcome = { solved: false, method: "2captcha", message: "2Captcha was not attempted" };
    for (let attempt = 1; attempt <= MAX_2CAPTCHA_ATTEMPTS; attempt++) {
      last = await solveWith2Captcha(page, detection);
      if (last.solved || !last.retryable) return last;
    }
    return last;
  }

  for (let attempt = 1; attempt <= MAX_SOLVE_ATTEMPTS; attempt++) {
    // --- Tier 2: Checkbox click (reCAPTCHA v2 only) ---
    if (detection.type === "RECAPTCHA_V2") {
      const clickResult = await solveWithCheckboxClick(page);
      if (clickResult.solved) return clickResult;
    }

    // --- Tier 3: AI vision-assisted solving ---
    const aiResult = await solveWithAiVision(page, detection);
    if (aiResult.solved) return aiResult;

    // Brief pause before retrying — some CAPTCHAs reload after a failed attempt
    if (attempt < MAX_SOLVE_ATTEMPTS) {
      await page.waitForTimeout(2_000);
    }
  }

  const reason = env.captchaApiKey
    ? "no sitekey could be read from the page for 2Captcha"
    : "CAPTCHA_API_KEY is not configured";
  return {
    solved: false,
    method: "none",
    message: `CAPTCHA (${detection.type ?? "unknown"}) could not be solved after ${MAX_SOLVE_ATTEMPTS} attempts (${reason})`,
  };
}

/* ── Tier 1: 2Captcha API ─────────────────────────────────────────────── */

type ApiOutcome = CaptchaSolveResult & { retryable?: boolean };

// Account-level problems: retrying can't help, so stop spending time (and stop hitting the
// API for every queued application) until someone fixes the key / tops up the balance.
const ACCOUNT_ERRORS: Record<string, string> = {
  ERROR_WRONG_USER_KEY: "the CAPTCHA_API_KEY is malformed",
  ERROR_KEY_DOES_NOT_EXIST: "the CAPTCHA_API_KEY does not exist",
  ERROR_ZERO_BALANCE: "the 2Captcha balance is empty — top up at 2captcha.com",
  ERROR_IP_NOT_ALLOWED: "this server's IP is not allowed for the API key",
  IP_BANNED: "this server's IP is banned by 2Captcha",
};
const RETRYABLE_ERRORS = new Set(["ERROR_CAPTCHA_UNSOLVABLE", "ERROR_NO_SLOT_AVAILABLE", "CAPCHA_NOT_READY"]);
const ACCOUNT_ERROR_COOLDOWN_MS = 10 * 60_000;
let accountErrorUntil = 0;
let accountErrorMessage = "";

async function twoCaptchaApi(path: "in.php" | "res.php", params: Record<string, string>, method: "GET" | "POST"): Promise<{ status: number; request: string }> {
  const body = new URLSearchParams({ ...params, json: "1" });
  const res = await fetch(method === "GET" ? `https://2captcha.com/${path}?${body}` : `https://2captcha.com/${path}`, {
    method,
    ...(method === "POST" ? { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
  });
  return (await res.json()) as { status: number; request: string };
}

function apiFailure(code: string, extra = ""): ApiOutcome {
  const accountIssue = ACCOUNT_ERRORS[code];
  if (accountIssue) {
    accountErrorMessage = `${accountIssue} (${code})`;
    accountErrorUntil = Date.now() + ACCOUNT_ERROR_COOLDOWN_MS;
    return { solved: false, method: "2captcha", message: `2Captcha unavailable: ${accountErrorMessage}` };
  }
  return { solved: false, method: "2captcha", message: `2Captcha error: ${code}${extra}`, retryable: RETRYABLE_ERRORS.has(code) };
}

const debug = (...args: unknown[]) => {
  if (process.env.CAPTCHA_DEBUG) console.log("[captcha]", ...args);
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function solveWith2Captcha(page: Page, detection: CaptchaDetection): Promise<ApiOutcome> {
  const apiKey = env.captchaApiKey;
  if (!apiKey || !detection.siteKey) {
    return { solved: false, method: "2captcha", message: "2Captcha API key or sitekey missing" };
  }
  if (Date.now() < accountErrorUntil) {
    return { solved: false, method: "2captcha", message: `2Captcha unavailable: ${accountErrorMessage}` };
  }

  try {
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");
    const task: Record<string, string> = { key: apiKey, pageurl: page.url() };
    if (userAgent) task.userAgent = userAgent;

    if (detection.type === "HCAPTCHA") {
      Object.assign(task, { method: "hcaptcha", sitekey: detection.siteKey });
      if (detection.invisible) task.invisible = "1";
    } else if (detection.type === "TURNSTILE") {
      Object.assign(task, { method: "turnstile", sitekey: detection.siteKey });
    } else {
      Object.assign(task, { method: "userrecaptcha", googlekey: detection.siteKey });
      if (detection.invisible) task.invisible = "1";
      if (detection.enterprise) task.enterprise = "1";
    }

    const submit = await twoCaptchaApi("in.php", task, "POST");
    if (submit.status !== 1) return apiFailure(submit.request, " (submit)");
    const taskId = submit.request;

    const startedAt = Date.now();
    await sleep(SOLVE_FIRST_POLL_DELAY_MS);

    while (Date.now() - startedAt < SOLVE_POLL_TIMEOUT_MS) {
      const poll = await twoCaptchaApi("res.php", { key: apiKey, action: "get", id: taskId }, "GET");
      if (poll.status === 1) {
        const token = poll.request;
        if (!(await injectCaptchaToken(page, detection, token))) {
          return { solved: false, method: "2captcha", message: `2Captcha returned a token (task ${taskId}) but the page has no ${detection.type} response field to put it in` };
        }
        tokenInjectedAt.set(page, Date.now());
        return { solved: true, method: "2captcha", message: `Solved via 2Captcha (${detection.type}${detection.invisible ? ", invisible" : ""}, task ${taskId})` };
      }
      if (poll.request !== "CAPCHA_NOT_READY") return apiFailure(poll.request, ` (task ${taskId})`);
      await sleep(SOLVE_POLL_INTERVAL_MS);
    }

    return { solved: false, method: "2captcha", message: `2Captcha solve timed out after ${SOLVE_POLL_TIMEOUT_MS / 1000}s (task ${taskId})`, retryable: true };
  } catch (err) {
    return { solved: false, method: "2captcha", message: `2Captcha error: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }
}

/* ── Cloudflare "Just a moment…" interstitial ─────────────────────────── */

const CHALLENGE_SELF_CLEAR_WAIT_MS = 8_000;
const CHALLENGE_PARAMS_WAIT_MS = 12_000;
const CHALLENGE_CLEAR_AFTER_TOKEN_MS = 20_000;

async function isChallengePage(page: Page): Promise<boolean> {
  return page
    .evaluate(() => /just a moment|checking your browser|verifying you are human/i.test(document.title) || "_cf_chl_opt" in window || !!document.querySelector("#challenge-form, #challenge-running, #challenge-stage"))
    .catch(() => false);
}

async function waitUntilChallengeClears(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isChallengePage(page))) return true;
    await sleep(500);
  }
  return !(await isChallengePage(page));
}

type V2Response = { errorId: number; errorCode?: string; errorDescription?: string; taskId?: number; status?: string; solution?: { token?: string; userAgent?: string } };

async function twoCaptchaV2(endpoint: "createTask" | "getTaskResult", body: Record<string, unknown>): Promise<V2Response> {
  const res = await fetch(`https://api.2captcha.com/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: env.captchaApiKey, ...body }),
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
  });
  return (await res.json()) as V2Response;
}

/**
 * Solves a full-page Cloudflare challenge. Non-interactive challenges often pass by
 * themselves within a few seconds, so wait for that first (free). Otherwise send the
 * parameters captured from the page's turnstile.render() call to 2Captcha and hand the
 * token back through the page's own callback, which makes Cloudflare issue the clearance
 * cookie and reload the real page.
 */
async function solveCloudflareChallenge(page: Page): Promise<CaptchaSolveResult> {
  if (await waitUntilChallengeClears(page, CHALLENGE_SELF_CLEAR_WAIT_MS)) {
    return { solved: true, method: "none", message: "Cloudflare check passed on its own" };
  }
  if (!env.captchaApiKey) {
    return { solved: false, method: "none", message: "Cloudflare challenge page and CAPTCHA_API_KEY is not configured" };
  }
  if (Date.now() < accountErrorUntil) {
    return { solved: false, method: "2captcha", message: `2Captcha unavailable: ${accountErrorMessage}` };
  }

  type Captured = { sitekey?: string; action?: string; cData?: string; chlPageData?: string };
  const readCaptured = () => page.evaluate(() => (window as unknown as { __cusTurnstile?: Captured }).__cusTurnstile ?? null).catch(() => null);
  let params: Captured | null = null;
  for (const deadline = Date.now() + CHALLENGE_PARAMS_WAIT_MS; Date.now() < deadline; ) {
    params = await readCaptured();
    if (params?.sitekey) break;
    await sleep(500);
  }
  if (!params?.sitekey) {
    return { solved: false, method: "2captcha", message: "Cloudflare challenge page: could not capture the Turnstile parameters (page did not call turnstile.render — it may be a hard block, not a solvable challenge)" };
  }

  try {
    const task: Record<string, unknown> = { type: "TurnstileTaskProxyless", websiteURL: page.url(), websiteKey: params.sitekey };
    if (params.action) task.action = params.action;
    if (params.cData) task.data = params.cData;
    if (params.chlPageData) task.pagedata = params.chlPageData;

    debug("cf task", { ...task, pagedata: String(task.pagedata).slice(0, 12), data: task.data, url: page.url().slice(0, 80) });
    const created = await twoCaptchaV2("createTask", { task });
    if (created.errorId !== 0 || !created.taskId) return apiFailure(created.errorCode ?? "UNKNOWN", " (createTask)");

    const startedAt = Date.now();
    await sleep(SOLVE_FIRST_POLL_DELAY_MS);
    while (Date.now() - startedAt < SOLVE_POLL_TIMEOUT_MS) {
      const result = await twoCaptchaV2("getTaskResult", { taskId: created.taskId });
      if (result.errorId !== 0) return apiFailure(result.errorCode ?? "UNKNOWN", ` (task ${created.taskId})`);
      if (result.status === "ready" && result.solution?.token) {
        // The page may have re-rendered (new cData) while we waited — use the latest callback.
        // Cloudflare ties the clearance to the browser that submits the token, and the token
        // was produced under the solver's user agent — present the same one (2Captcha docs).
        if (result.solution.userAgent) {
          await page
            .context()
            .newCDPSession(page)
            .then((cdp) => cdp.send("Network.setUserAgentOverride", { userAgent: result.solution!.userAgent! }))
            .catch(() => debug("cf: could not override user agent"));
        }
        const nowParams = await readCaptured();
        debug("cf deliver", { sameCData: nowParams?.cData === params.cData, sameAction: nowParams?.action === params.action, ua: result.solution.userAgent, url: page.url().slice(0, 80) });
        const delivered = await page
          .evaluate((token) => {
            const cb = (window as unknown as { __cusTurnstile?: { callback?: (t: string) => void } }).__cusTurnstile?.callback;
            if (typeof cb !== "function") return false;
            cb(token);
            return true;
          }, result.solution.token)
          .catch(() => false);
        if (!delivered) {
          return { solved: false, method: "2captcha", message: `2Captcha solved the Cloudflare challenge (task ${created.taskId}) but the page exposed no callback to hand the token to` };
        }
        const cleared = await waitUntilChallengeClears(page, CHALLENGE_CLEAR_AFTER_TOKEN_MS);
        tokenInjectedAt.set(page, Date.now());
        return cleared
          ? { solved: true, method: "2captcha", message: `Solved Cloudflare challenge via 2Captcha (task ${created.taskId})` }
          : { solved: false, method: "2captcha", message: `Cloudflare rejected the 2Captcha token (task ${created.taskId}); the challenge page is still showing` };
      }
      await sleep(SOLVE_POLL_INTERVAL_MS);
    }
    return { solved: false, method: "2captcha", message: `2Captcha Cloudflare solve timed out after ${SOLVE_POLL_TIMEOUT_MS / 1000}s (task ${created.taskId})` };
  } catch (err) {
    return { solved: false, method: "2captcha", message: `2Captcha error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Writes the solved token into the widget's response field(s) and fires the widget's
 * callback (invisible widgets submit/advance the form from it). Returns false when the
 * page has no response field to receive the token. It deliberately does NOT click any
 * submit button — the apply flow does that once the form is actually filled in.
 */
async function injectCaptchaToken(page: Page, detection: CaptchaDetection, token: string): Promise<boolean> {
  return page.evaluate(
    ({ type, token }) => {
      // tsx/esbuild wraps named inner functions in a __name() helper that doesn't exist in the browser.
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      const fieldSelector =
        type === "HCAPTCHA"
          ? "textarea[name='h-captcha-response'], textarea[name='g-recaptcha-response']"
          : type === "TURNSTILE"
            ? "input[name='cf-turnstile-response']"
            : "textarea[name='g-recaptcha-response'], #g-recaptcha-response";
      const widgetSelector = type === "HCAPTCHA" ? ".h-captcha" : type === "TURNSTILE" ? ".cf-turnstile" : ".g-recaptcha";

      const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(fieldSelector));
      for (const field of fields) {
        field.value = token;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const win = window as unknown as Record<string, unknown>;
      const callbacks = new Set<(t: string) => void>();

      // 1) Callback named by the data-callback attribute (may be a dotted path)
      document.querySelectorAll(widgetSelector).forEach((widget) => {
        const name = widget.getAttribute("data-callback");
        if (!name) return;
        const fn = name.split(".").reduce<unknown>((obj, key) => (obj as Record<string, unknown> | undefined)?.[key], win);
        if (typeof fn === "function") callbacks.add(fn as (t: string) => void);
      });

      // 2) reCAPTCHA stores programmatic callbacks several levels deep in ___grecaptcha_cfg
      if (type === "RECAPTCHA_V2") {
        const seen = new Set<object>();
        const walk = (node: unknown, depth: number) => {
          if (!node || typeof node !== "object" || depth > 5 || node instanceof Node || seen.has(node)) return;
          seen.add(node);
          for (const [key, value] of Object.entries(node)) {
            if (key === "callback" && typeof value === "function") callbacks.add(value as (t: string) => void);
            else walk(value, depth + 1);
          }
        };
        walk((win["___grecaptcha_cfg"] as { clients?: unknown } | undefined)?.clients, 0);
      }

      for (const callback of callbacks) {
        try {
          callback(token);
        } catch {
          // a throwing site callback must not discard an otherwise valid injection
        }
      }
      return fields.length > 0 || callbacks.size > 0;
    },
    { type: detection.type, token }
  );
}

/* ── Tier 2: Checkbox click (reCAPTCHA v2) ────────────────────────────── */

async function solveWithCheckboxClick(page: Page): Promise<CaptchaSolveResult> {
  try {
    // The reCAPTCHA v2 checkbox lives inside an iframe — locate and click it
    const recaptchaFrame = page.frameLocator('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
    const checkbox = recaptchaFrame.locator("#recaptcha-anchor, .recaptcha-checkbox-border");

    if ((await checkbox.count()) === 0) {
      return { solved: false, method: "checkbox_click", message: "reCAPTCHA checkbox not found in iframe" };
    }

    await checkbox.first().click();
    // Wait for the checkmark animation / potential image challenge to appear
    await page.waitForTimeout(3_000);

    // Check if the checkbox is now checked (challenge solved without image grid)
    const isChecked = await recaptchaFrame
      .locator('.recaptcha-checkbox-checked, #recaptcha-anchor[aria-checked="true"]')
      .count();

    if (isChecked > 0) {
      // Verify no image challenge appeared (bingo challenge opened in second iframe)
      await page.waitForTimeout(1_000);
      const challengeFrame = page.locator('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]');
      const challengeVisible = (await challengeFrame.count()) > 0 && (await challengeFrame.first().isVisible().catch(() => false));
      if (!challengeVisible) {
        return { solved: true, method: "checkbox_click", message: "reCAPTCHA v2 solved via checkbox click (no image challenge)" };
      }
    }

    return { solved: false, method: "checkbox_click", message: "Checkbox clicked but image challenge appeared — cannot solve without API" };
  } catch (err) {
    return { solved: false, method: "checkbox_click", message: `Checkbox click failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ── Tier 3: AI vision-assisted solving ───────────────────────────────── */

async function solveWithAiVision(page: Page, detection: CaptchaDetection): Promise<CaptchaSolveResult> {
  if (!env.openrouterApiKey) {
    return { solved: false, method: "ai_vision", message: "OpenRouter API key not configured for AI vision" };
  }

  try {
    const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
    if (!screenshot) {
      return { solved: false, method: "ai_vision", message: "Could not capture screenshot for AI analysis" };
    }

    const imageUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
    const prompt = `You are an automation assistant. The screenshot shows a CAPTCHA challenge (type: ${detection.type ?? "unknown"}) on a job application page.

Analyze the screenshot and respond with ONLY a JSON object:
{
  "captchaType": "the type of CAPTCHA you see",
  "canSolve": true or false,
  "action": "description of what to do — e.g. 'click the checkbox at coordinates (x, y)' or 'select all images with traffic lights'",
  "clickTarget": { "x": number, "y": number } or null if no single click will solve it,
  "explanation": "brief explanation of what you see"
}

Focus on identifying if this is a simple checkbox CAPTCHA that can be solved with a single click, and if so, provide the exact pixel coordinates of the checkbox center.`;

    const VISION_MODELS = ["inclusionai/ling-3.0-flash-vl:free", "qwen/qwen3.8-27b:free", "google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"];

    for (const modelId of VISION_MODELS) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.openrouterApiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: imageUrl } },
                ],
              },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
          }),
        });

        if (!res.ok) continue;
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = body.choices?.[0]?.message?.content;
        if (!content) continue;

        const parsed = parseAiVisionResponse(content);
        if (!parsed) continue;

        if (parsed.canSolve && parsed.clickTarget) {
          await page.mouse.click(parsed.clickTarget.x, parsed.clickTarget.y);
          await page.waitForTimeout(3_000);
          const stillThere = await detectCaptcha(page);
          if (!stillThere) {
            return { solved: true, method: "ai_vision", message: `AI vision solved CAPTCHA via click at (${parsed.clickTarget.x}, ${parsed.clickTarget.y}): ${parsed.explanation}` };
          }
        }

        // AI analyzed it but couldn't solve it with a click
        return {
          solved: false,
          method: "ai_vision",
          message: `AI vision analysis: ${parsed.explanation} (canSolve: ${parsed.canSolve})`,
        };
      } catch {
        // try next vision model
      }
    }

    return { solved: false, method: "ai_vision", message: "All AI vision models failed to analyze the CAPTCHA" };
  } catch (err) {
    return { solved: false, method: "ai_vision", message: `AI vision error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface AiVisionCaptchaResponse {
  captchaType: string;
  canSolve: boolean;
  action: string;
  clickTarget: { x: number; y: number } | null;
  explanation: string;
}

function parseAiVisionResponse(raw: string): AiVisionCaptchaResponse | null {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as AiVisionCaptchaResponse;
    if (typeof parsed.canSolve !== "boolean" || typeof parsed.explanation !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
