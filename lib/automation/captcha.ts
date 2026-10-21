import type { BrowserContext, Frame, Page } from "playwright";
import { env } from "@/lib/env";
import { VISION_MODELS } from "@/lib/adapters/visionAdapter";

/* ────────────────────────────────────────────────────────────────────────────
 * CAPTCHA Detection
 * ────────────────────────────────────────────────────────────────────────── */

/** The type of CAPTCHA detected on the page, or null if none found. */
export type CaptchaType = "RECAPTCHA_V2" | "HCAPTCHA" | "TURNSTILE" | "IMAGE_TEXT" | "UNKNOWN";

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
  /** The frame that holds the widget (main frame or an iframe-embedded form); tokens go back into this one. */
  frame?: Frame;
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
  // tsx/esbuild wraps named functions in a __name() helper that doesn't exist inside the browser, so any
  // page.evaluate() that contains a named inner function throws "__name is not defined". Defining it
  // in every page makes that class of bug impossible instead of patching each call site.
  await context.addInitScript("window.__name = window.__name || function (f) { return f; };");
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

/**
 * Looks for a CAPTCHA in the main document and in every embedded frame — ATS forms are often
 * iframed (Greenhouse/Workable embeds etc.) and their widget lives inside that iframe, not on
 * the top-level page. The captcha providers' own iframes are skipped; they hold the widget UI,
 * not the page's response field.
 */
export async function detectCaptchaDetails(page: Page): Promise<CaptchaDetection> {
  const mainFrame = page.mainFrame();
  const main = await scanFrame(mainFrame, true);
  if (main.hardBlock || main.challengePage) return main;

  const found: CaptchaDetection[] = main.detected ? [main] : [];
  for (const frame of page.frames()) {
    if (frame === mainFrame || frame.isDetached() || /recaptcha|hcaptcha.com|challenges.cloudflare.com/i.test(frame.url())) continue;
    const detection = await scanFrame(frame, false);
    if (detection.detected) found.push(detection);
  }
  // A concrete widget (with a sitekey to solve) beats a vague "looks like a captcha" text hit.
  return found.find((d) => d.type !== "UNKNOWN") ?? found[0] ?? NOT_DETECTED;
}

interface RawScan {
  hardBlock: boolean;
  challengePage: boolean;
  capturedSiteKey: string | null;
  recaptcha: { siteKey: string | null; invisible: boolean; enterprise: boolean; src: string | null } | null;
  hcaptcha: { siteKey: string | null; invisible: boolean; src: string | null } | null;
  turnstile: { siteKey: string | null; src: string | null } | null;
  genericIframe: boolean;
  /** A "type the characters in the picture" captcha: an image plus the box to type it into. */
  imageCaptcha: { filled: boolean } | null;
  bodyText: string;
  tokens: { recaptcha: boolean; hcaptcha: boolean; turnstile: boolean };
}

async function scanFrame(frame: Frame, isMain: boolean): Promise<CaptchaDetection> {
  const scan = await frame
    .evaluate((isMain) => {
      // tsx/esbuild wraps named inner functions in a __name() helper that doesn't exist in the browser.
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      const win = window;
      const all = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
      const hasAll = (sel: string) => {
        const els = all(sel);
        return els.length > 0 && els.every((el) => ((el as HTMLInputElement).value ?? "").trim().length > 0);
      };
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

      // hCaptcha is very often rendered inside a "g-recaptcha"-classed element (its compatibility mode), and
      // its sitekeys are UUIDs while reCAPTCHA's start with "6L" — so the class name alone proves nothing.
      const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const hcScript = !!document.querySelector('script[src*="hcaptcha.com"]');
      const anyKeyed = all("[data-sitekey]");
      const rcCandidate = all(".g-recaptcha[data-sitekey]")[0];
      const rcDivIsHc = !!rcCandidate && (UUID_KEY.test(rcCandidate.getAttribute("data-sitekey") ?? "") || (hcScript && !document.querySelector('script[src*="recaptcha/"]')));
      const rcDiv = rcDivIsHc ? undefined : rcCandidate;
      const rcFrame = all('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]')[0] as HTMLIFrameElement | undefined;
      // reCAPTCHA v3 loads api.js?render=<sitekey> and shows only a corner badge (an invisible
      // "anchor" iframe). There is nothing to solve on the page — the site scores the session
      // when the form is submitted — so it must not be mistaken for a v2 challenge.
      const v3Render = all('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]')
        .map((s) => query((s as HTMLScriptElement).src).get("render"))
        .find((r) => r && r !== "explicit");
      let recaptcha: { siteKey: string | null; invisible: boolean; enterprise: boolean; src: string | null } | null = null;
      if (rcDiv) {
        const siteKey = rcDiv.getAttribute("data-sitekey");
        // The anchor frame for THIS widget's key decides enterprise vs standard (a page can carry several).
        const own = all('iframe[src*="recaptcha/"]').find((f) => query((f as HTMLIFrameElement).src).get("k") === siteKey) as HTMLIFrameElement | undefined;
        recaptcha = {
          siteKey,
          // A button/submit carrying the sitekey is the "invisible" flavour: the challenge fires when it is pressed.
          invisible: rcDiv.getAttribute("data-size") === "invisible" || /^(button|input)$/i.test(rcDiv.tagName),
          enterprise: !!(own ?? rcFrame)?.src.includes("/enterprise/"),
          src: (own ?? rcFrame)?.src ?? null,
        };
      } else if (rcFrame && !v3Render) {
        const q = query(rcFrame.src);
        recaptcha = { siteKey: q.get("k"), invisible: q.get("size") === "invisible", enterprise: rcFrame.src.includes("/enterprise/"), src: rcFrame.src };
      }

      // --- hCaptcha ---
      const hcDiv = all(".h-captcha[data-sitekey]")[0] ?? (rcDivIsHc ? rcCandidate : undefined) ?? anyKeyed.find((e) => UUID_KEY.test(e.getAttribute("data-sitekey") ?? ""));
      const hcFrame = all('iframe[src*="hcaptcha.com"]')[0] as HTMLIFrameElement | undefined;
      const hcField = all("textarea[name='h-captcha-response'], input[name='h-captcha-response']").length > 0;
      const hcaptcha =
        hcDiv || hcFrame || (hcScript && hcField)
          ? {
              siteKey: hcDiv?.getAttribute("data-sitekey") ?? (hcFrame ? hash(hcFrame.src).get("sitekey") : null),
              invisible: hcDiv?.getAttribute("data-size") === "invisible",
              src: hcFrame?.src ?? null,
            }
          : null;

      // --- Cloudflare Turnstile ---
      const tsDiv = all(".cf-turnstile[data-sitekey]")[0];
      const tsFrame = all('iframe[src*="challenges.cloudflare.com"]')[0] as HTMLIFrameElement | undefined;
      const captured = (win as unknown as { __cusTurnstile?: { sitekey?: string } }).__cusTurnstile;
      // Turnstile is often rendered from script with no .cf-turnstile element and an iframe we cannot see
      // into. What always remains: the script, the response field, and the sitekey our render hook captured.
      const tsScript = !!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
      const tsField = all("input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response']").length > 0;
      const turnstile =
        tsDiv || tsFrame || (tsScript && (tsField || captured?.sitekey))
          ? {
              siteKey: tsDiv?.getAttribute("data-sitekey") ?? captured?.sitekey ?? tsFrame?.src.match(/\/(0x[0-9A-Za-z_-]+)\//)?.[1] ?? null,
              src: tsFrame?.src ?? null,
            }
          : null;

      // Cloudflare interstitial: title is the reliable marker; _cf_chl_opt / #challenge-form
      // exist only on challenge pages (the cdn-cgi/challenge-platform script alone is also
      // loaded on ordinary Cloudflare-fronted sites, so it is NOT used as a signal).
      const challengePage =
        isMain &&
        (/just a moment|checking your browser|verifying you are human/i.test(document.title) ||
          "_cf_chl_opt" in window ||
          !!document.querySelector("#challenge-form, #challenge-running, #challenge-stage"));

      // "Attention Required! | Cloudflare" / "Sorry, you have been blocked" (error 1020 etc.):
      // the site refused this IP/browser outright — there is no widget to solve.
      const hardBlock = isMain && /attention required.*cloudflare|access denied/i.test(document.title) && /sorry, you have been blocked|cloudflare ray id/i.test(document.body?.innerText ?? "");

      return {
        hardBlock,
        challengePage,
        capturedSiteKey: captured?.sitekey ?? null,
        recaptcha,
        hcaptcha,
        turnstile,
        // Only a captcha iframe a person could actually see counts. Sites like LinkedIn load a hidden,
        // zero-size "reCAPTCHA" iframe on every page purely to score the session — it is not a challenge.
        imageCaptcha: (() => {
          document.querySelectorAll("[data-cus-captcha-img], [data-cus-captcha-input]").forEach((e) => {
            e.removeAttribute("data-cus-captcha-img");
            e.removeAttribute("data-cus-captcha-input");
          });
          const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
          const img = all("img").find((i) => visible(i) && /captcha/i.test(`${(i as HTMLImageElement).src} ${i.id} ${i.className?.toString?.() ?? ""} ${(i as HTMLImageElement).alt}`) && (i as HTMLImageElement).width >= 40);
          if (!img) return null;
          const label = (el: HTMLInputElement) => `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${el.labels?.[0]?.textContent ?? ""}`;
          const inputs = all("input").filter((i) => visible(i) && ["text", "tel", "number", ""].includes(((i as HTMLInputElement).type ?? "").toLowerCase()));
          const input = (inputs.find((i) => /captcha|security[\s_-]?code|characters|letters shown|type the (text|code)/i.test(label(i as HTMLInputElement))) ?? inputs.find((i) => img.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)) as HTMLInputElement | undefined;
          if (!input) return null;
          img.setAttribute("data-cus-captcha-img", "1");
          input.setAttribute("data-cus-captcha-input", "1");
          return { filled: input.value.trim().length > 0 };
        })(),
        genericIframe: all('iframe[title*="captcha" i]').some((el) => {
          const r = el.getBoundingClientRect();
          return r.width >= 30 && r.height >= 30 && getComputedStyle(el).visibility !== "hidden" && !el.closest('[hidden], [aria-hidden="true"]');
        }),
        bodyText: isMain ? (document.body?.innerText ?? "") : "",
        // "Solved" means EVERY response field of that kind holds a token. A page with a visible widget plus a
        // passive score-only reCAPTCHA has two fields, and the passive one is filled from the start.
        tokens: {
          recaptcha: hasAll("textarea[name='g-recaptcha-response'], #g-recaptcha-response"),
          hcaptcha: hasAll("textarea[name='h-captcha-response'], input[name='h-captcha-response']"),
          turnstile: hasAll("input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response']"),
        },
      };
    }, isMain)
    .catch(() => null);

  if (!scan) return NOT_DETECTED;
  const result = classifyScan(scan);
  return result.detected ? { ...result, frame } : result;
}

function classifyScan(scan: RawScan): CaptchaDetection {

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
  if (scan.imageCaptcha) {
    return { ...NOT_DETECTED, detected: true, type: "IMAGE_TEXT", tokenPresent: scan.imageCaptcha.filled };
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

  // --- "Type the characters in the picture" ---
  if (detection.type === "IMAGE_TEXT") {
    if (!env.captchaApiKey) return { solved: false, method: "none", message: "Image CAPTCHA found and CAPTCHA_API_KEY is not configured" };
    return solveImageCaptcha(page, detection);
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

/** Reads the picture, has 2Captcha transcribe it, and types the answer into the box next to it. */
async function solveImageCaptcha(page: Page, detection: CaptchaDetection): Promise<CaptchaSolveResult> {
  const apiKey = env.captchaApiKey!;
  if (Date.now() < accountErrorUntil) return { solved: false, method: "2captcha", message: `2Captcha unavailable: ${accountErrorMessage}` };
  const frame = detection.frame ?? page.mainFrame();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const image = frame.locator("[data-cus-captcha-img]").first();
      const input = frame.locator("[data-cus-captcha-input]").first();
      if ((await image.count()) === 0 || (await input.count()) === 0) return { solved: false, method: "2captcha", message: "Image CAPTCHA: the picture or its answer box disappeared" };

      const png = await image.screenshot({ timeout: 8_000 });
      const submit = await twoCaptchaApi("in.php", { key: apiKey, method: "base64", body: png.toString("base64"), regsense: "1", textinstructions: "Type the characters shown in the image exactly" }, "POST");
      if (submit.status !== 1) return apiFailure(submit.request, " (image submit)");

      const startedAt = Date.now();
      await sleep(5_000); // text captchas are solved in seconds
      while (Date.now() - startedAt < 90_000) {
        const poll = await twoCaptchaApi("res.php", { key: apiKey, action: "get", id: submit.request }, "GET");
        if (poll.status === 1) {
          await input.fill(poll.request, { timeout: 5_000 });
          tokenInjectedAt.set(page, Date.now());
          return { solved: true, method: "2captcha", message: `Solved the image CAPTCHA via 2Captcha (typed "${poll.request}", task ${submit.request})` };
        }
        if (poll.request !== "CAPCHA_NOT_READY") {
          const failure = apiFailure(poll.request, " (image)");
          if (!failure.retryable || attempt === 2) return failure;
          break;
        }
        await sleep(3_000);
      }
    } catch (err) {
      if (attempt === 2) return { solved: false, method: "2captcha", message: `Image CAPTCHA error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { solved: false, method: "2captcha", message: "Image CAPTCHA could not be solved" };
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
    const frame = detection.frame ?? page.mainFrame();
    const userAgent = await frame.evaluate(() => navigator.userAgent).catch(() => "");
    // reCAPTCHA/hCaptcha bind the token to the origin that renders the widget — for an iframed form
    // that is the iframe's URL, not the top-level page's.
    const task: Record<string, string> = { key: apiKey, pageurl: frame.url() || page.url() };
    if (userAgent) task.userAgent = userAgent;

    if (detection.type === "HCAPTCHA") {
      Object.assign(task, { method: "hcaptcha", sitekey: detection.siteKey });
      if (detection.invisible) task.invisible = "1";
    } else if (detection.type === "TURNSTILE") {
      Object.assign(task, { method: "turnstile", sitekey: detection.siteKey });
      // A Turnstile widget can be bound to an action / cData; the token is only valid if the solver echoes them.
      const extras = await frame
        .evaluate(() => {
          const kept = (window as unknown as { __cusTurnstile?: { action?: string; cData?: string; chlPageData?: string } }).__cusTurnstile;
          const el = document.querySelector(".cf-turnstile");
          return { action: kept?.action ?? el?.getAttribute("data-action") ?? "", data: kept?.cData ?? el?.getAttribute("data-cdata") ?? "", pagedata: kept?.chlPageData ?? "" };
        })
        .catch(() => ({ action: "", data: "", pagedata: "" }));
      if (extras.action) task.action = extras.action;
      if (extras.data) task.data = extras.data;
      if (extras.pagedata) task.pagedata = extras.pagedata;
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
        if (!(await injectCaptchaToken(detection.frame ?? page.mainFrame(), detection, token))) {
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
async function injectCaptchaToken(ctx: Page | Frame, detection: CaptchaDetection, token: string): Promise<boolean> {
  return ctx.evaluate(
    ({ type, token }) => {
      // tsx/esbuild wraps named inner functions in a __name() helper that doesn't exist in the browser.
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      const fieldSelector =
        type === "HCAPTCHA"
          ? "textarea[name='h-captcha-response'], input[name='h-captcha-response'], textarea[name='g-recaptcha-response']"
          : type === "TURNSTILE"
            ? "input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response']"
            : "textarea[name='g-recaptcha-response'], #g-recaptcha-response";
      // hCaptcha's compatibility mode puts the widget (and its data-callback) on a "g-recaptcha" element.
      const widgetSelector = type === "HCAPTCHA" ? ".h-captcha, .g-recaptcha, [data-sitekey]" : type === "TURNSTILE" ? ".cf-turnstile, [data-sitekey]" : ".g-recaptcha, [data-sitekey]";

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

      // 1b) A Turnstile widget rendered from script hands its callback to turnstile.render(); our render hook kept it.
      if (type === "TURNSTILE") {
        const kept = (win["__cusTurnstile"] as { callback?: unknown } | undefined)?.callback;
        if (typeof kept === "function") callbacks.add(kept as (t: string) => void);
      }

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
