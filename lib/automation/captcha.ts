import type { Page } from "playwright";
import { env } from "@/lib/env";

/* ────────────────────────────────────────────────────────────────────────────
 * CAPTCHA Detection
 * ────────────────────────────────────────────────────────────────────────── */

/** The type of CAPTCHA detected on the page, or null if none found. */
export type CaptchaType = "RECAPTCHA_V2" | "RECAPTCHA_V3" | "HCAPTCHA" | "TURNSTILE" | "UNKNOWN";

export interface CaptchaDetection {
  detected: boolean;
  type: CaptchaType | null;
  siteKey: string | null;
  iframeUrl: string | null;
}

/**
 * Detects a CAPTCHA challenge on the current page and identifies its type +
 * sitekey when possible. This information is then used by solveCaptcha() to
 * pick the right solving strategy.
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  const detection = await detectCaptchaDetails(page);
  return detection.detected;
}

export async function detectCaptchaDetails(page: Page): Promise<CaptchaDetection> {
  // --- reCAPTCHA v2 ---
  const recaptchaIframe = page.locator('iframe[src*="recaptcha"]');
  if ((await recaptchaIframe.count()) > 0) {
    const src = await recaptchaIframe.first().getAttribute("src").catch(() => null);
    const siteKey = await extractSiteKey(page, "recaptcha");
    return { detected: true, type: "RECAPTCHA_V2", siteKey, iframeUrl: src };
  }

  const recaptchaDiv = page.locator(".g-recaptcha, [data-sitekey]");
  if ((await recaptchaDiv.count()) > 0) {
    const siteKey = await recaptchaDiv.first().getAttribute("data-sitekey").catch(() => null);
    // reCAPTCHA v3 typically has a data-size="invisible" or is loaded with explicit rendering
    const isInvisible = await page.locator('.g-recaptcha[data-size="invisible"]').count();
    return {
      detected: true,
      type: isInvisible > 0 ? "RECAPTCHA_V3" : "RECAPTCHA_V2",
      siteKey,
      iframeUrl: null,
    };
  }

  // --- hCaptcha ---
  const hcaptchaIframe = page.locator('iframe[src*="hcaptcha"]');
  if ((await hcaptchaIframe.count()) > 0) {
    const src = await hcaptchaIframe.first().getAttribute("src").catch(() => null);
    const siteKey = await extractSiteKey(page, "hcaptcha");
    return { detected: true, type: "HCAPTCHA", siteKey, iframeUrl: src };
  }

  const hcaptchaDiv = page.locator(".h-captcha");
  if ((await hcaptchaDiv.count()) > 0) {
    const siteKey = await hcaptchaDiv.first().getAttribute("data-sitekey").catch(() => null);
    return { detected: true, type: "HCAPTCHA", siteKey, iframeUrl: null };
  }

  // --- Cloudflare Turnstile ---
  const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]');
  if ((await turnstileIframe.count()) > 0) {
    const siteKey = await page.locator(".cf-turnstile").first().getAttribute("data-sitekey").catch(() => null);
    return { detected: true, type: "TURNSTILE", siteKey, iframeUrl: null };
  }

  // --- Generic captcha text ---
  const captchaIframe = page.locator('iframe[title*="captcha" i]');
  if ((await captchaIframe.count()) > 0) {
    return { detected: true, type: "UNKNOWN", siteKey: null, iframeUrl: null };
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/verify (that )?you.{0,15}(human|robot)|complete the captcha/i.test(bodyText)) {
    return { detected: true, type: "UNKNOWN", siteKey: null, iframeUrl: null };
  }

  return { detected: false, type: null, siteKey: null, iframeUrl: null };
}

async function extractSiteKey(page: Page, provider: "recaptcha" | "hcaptcha"): Promise<string | null> {
  const selectors = provider === "recaptcha" ? [".g-recaptcha", "[data-sitekey]"] : [".h-captcha", "[data-sitekey]"];
  for (const sel of selectors) {
    const key = await page.locator(sel).first().getAttribute("data-sitekey").catch(() => null);
    if (key) return key;
  }
  return null;
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
const SOLVE_POLL_INTERVAL_MS = 5_000;
const SOLVE_POLL_TIMEOUT_MS = 120_000;

/**
 * Attempts to solve the detected CAPTCHA using a tiered strategy:
 *
 * 1. **2Captcha API** (production) — if CAPTCHA_API_KEY is configured, sends
 *    the sitekey + page URL to 2Captcha's API and injects the response token.
 *    This is the most reliable method and supports reCAPTCHA v2/v3, hCaptcha,
 *    and Turnstile.
 *
 * 2. **Checkbox click** (dev fallback) — for reCAPTCHA v2, attempts to click
 *    the "I'm not a robot" checkbox inside the iframe. Works in local/dev
 *    environments where reCAPTCHA's risk analysis scores the session as low-risk.
 *
 * 3. **AI vision** (dev fallback) — takes a screenshot and asks the AI vision
 *    chain to identify what type of challenge is shown and suggest an action.
 *    This is a best-effort heuristic, not a guaranteed solve.
 *
 * Returns a result indicating whether the CAPTCHA was cleared. The caller
 * (applyEngine.ts) decides whether to continue or hand off to a human based
 * on `result.solved`.
 */
export async function solveCaptcha(page: Page): Promise<CaptchaSolveResult> {
  const detection = await detectCaptchaDetails(page);
  if (!detection.detected) {
    return { solved: true, method: "none", message: "No CAPTCHA detected on re-check" };
  }

  for (let attempt = 1; attempt <= MAX_SOLVE_ATTEMPTS; attempt++) {
    // --- Tier 1: 2Captcha API (production) ---
    if (env.captchaApiKey && detection.siteKey) {
      const apiResult = await solveWith2Captcha(page, detection);
      if (apiResult.solved) return apiResult;
      // If 2Captcha failed, don't fall through to cheaper methods — it means
      // something is genuinely wrong (bad sitekey, page changed, etc.)
      if (attempt === MAX_SOLVE_ATTEMPTS) return apiResult;
      continue;
    }

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

  return {
    solved: false,
    method: "none",
    message: `CAPTCHA (${detection.type ?? "unknown"}) could not be solved after ${MAX_SOLVE_ATTEMPTS} attempts`,
  };
}

/* ── Tier 1: 2Captcha API ─────────────────────────────────────────────── */

async function solveWith2Captcha(page: Page, detection: CaptchaDetection): Promise<CaptchaSolveResult> {
  const apiKey = env.captchaApiKey;
  if (!apiKey || !detection.siteKey) {
    return { solved: false, method: "2captcha", message: "2Captcha API key or sitekey missing" };
  }

  const pageUrl = page.url();
  const methodMap: Record<string, string> = {
    RECAPTCHA_V2: "userrecaptcha",
    RECAPTCHA_V3: "userrecaptcha",
    HCAPTCHA: "hcaptcha",
    TURNSTILE: "turnstile",
  };
  const method = methodMap[detection.type ?? ""] ?? "userrecaptcha";

  try {
    // Step 1: Submit the CAPTCHA task
    const submitParams = new URLSearchParams({
      key: apiKey,
      method,
      googlekey: detection.siteKey,
      sitekey: detection.siteKey,
      pageurl: pageUrl,
      json: "1",
    });

    // reCAPTCHA v3 needs action and min_score
    if (detection.type === "RECAPTCHA_V3") {
      submitParams.set("version", "v3");
      submitParams.set("action", "submit");
      submitParams.set("min_score", "0.3");
    }

    const submitRes = await fetch(`https://2captcha.com/in.php?${submitParams.toString()}`);
    const submitBody = (await submitRes.json()) as { status: number; request: string };
    if (submitBody.status !== 1) {
      return { solved: false, method: "2captcha", message: `2Captcha submit failed: ${submitBody.request}` };
    }

    const taskId = submitBody.request;

    // Step 2: Poll for the solution
    const startTime = Date.now();
    await page.waitForTimeout(SOLVE_POLL_INTERVAL_MS); // initial wait before first poll

    while (Date.now() - startTime < SOLVE_POLL_TIMEOUT_MS) {
      const pollRes = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
      const pollBody = (await pollRes.json()) as { status: number; request: string };

      if (pollBody.status === 1) {
        // Got a solution — inject it into the page
        const token = pollBody.request;
        await injectCaptchaToken(page, detection, token);
        // Verify the CAPTCHA is gone after injection
        await page.waitForTimeout(2_000);
        const stillThere = await detectCaptcha(page);
        if (!stillThere) {
          return { solved: true, method: "2captcha", message: `Solved via 2Captcha (${detection.type}, task ${taskId})` };
        }
        // Token injected but CAPTCHA still showing — might need form submission
        await trySubmitAfterTokenInjection(page);
        await page.waitForTimeout(2_000);
        const stillThereAfterSubmit = await detectCaptcha(page);
        return {
          solved: !stillThereAfterSubmit,
          method: "2captcha",
          message: stillThereAfterSubmit
            ? "2Captcha token injected but CAPTCHA still present after submission attempt"
            : `Solved via 2Captcha after form submission (${detection.type}, task ${taskId})`,
        };
      }

      if (pollBody.request !== "CAPCHA_NOT_READY") {
        return { solved: false, method: "2captcha", message: `2Captcha error: ${pollBody.request}` };
      }

      await page.waitForTimeout(SOLVE_POLL_INTERVAL_MS);
    }

    return { solved: false, method: "2captcha", message: "2Captcha solve timed out" };
  } catch (err) {
    return { solved: false, method: "2captcha", message: `2Captcha error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function injectCaptchaToken(page: Page, detection: CaptchaDetection, token: string): Promise<void> {
  if (detection.type === "RECAPTCHA_V2" || detection.type === "RECAPTCHA_V3") {
    await page.evaluate((t) => {
      const el = document.querySelector("#g-recaptcha-response, [name='g-recaptcha-response']") as HTMLTextAreaElement | null;
      if (el) {
        el.style.display = "block";
        el.value = t;
        el.style.display = "none";
      }
      // Also try the callback if registered
      const grecaptchaCfg = (window as unknown as Record<string, any>)["___grecaptcha_cfg"];
      if (grecaptchaCfg) {
        try {
          const clients = grecaptchaCfg["clients"];
          if (clients) {
            for (const clientKey of Object.keys(clients)) {
              const client = clients[clientKey];
              for (const propKey of Object.keys(client)) {
                const prop = client[propKey];
                if (prop && typeof prop === "object" && typeof prop.callback === "function") {
                  prop.callback(t);
                }
              }
            }
          }
        } catch {
          // best-effort callback invocation
        }
      }
    }, token);
  } else if (detection.type === "HCAPTCHA") {
    await page.evaluate((t) => {
      const el = document.querySelector("[name='h-captcha-response'], [name='g-recaptcha-response']") as HTMLTextAreaElement | null;
      if (el) {
        el.style.display = "block";
        el.value = t;
        el.style.display = "none";
      }
      // hCaptcha callback
      try {
        const hcaptchaObj = (window as unknown as Record<string, { getRespKey?: () => string }>)["hcaptcha"];
        if (hcaptchaObj) {
          const textarea = document.querySelector("textarea[name='h-captcha-response']") as HTMLTextAreaElement | null;
          if (textarea) textarea.value = t;
        }
      } catch {
        // best-effort
      }
    }, token);
  } else if (detection.type === "TURNSTILE") {
    await page.evaluate((t) => {
      const el = document.querySelector("[name='cf-turnstile-response']") as HTMLInputElement | null;
      if (el) el.value = t;
      // Turnstile callback
      try {
        const turnstileWidgets = document.querySelectorAll(".cf-turnstile");
        turnstileWidgets.forEach((widget) => {
          const callbackName = widget.getAttribute("data-callback");
          if (callbackName && typeof (window as unknown as Record<string, (...args: unknown[]) => void>)[callbackName] === "function") {
            (window as unknown as Record<string, (...args: unknown[]) => void>)[callbackName](t);
          }
        });
      } catch {
        // best-effort
      }
    }, token);
  }
}

async function trySubmitAfterTokenInjection(page: Page): Promise<void> {
  // Some forms auto-submit when the CAPTCHA callback fires, but others need the
  // user to click a submit button. Try clicking the nearest submit-looking control.
  const submitControl = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Continue"), button:has-text("Verify")'
  );
  if ((await submitControl.count()) > 0) {
    await submitControl.first().click().catch(() => {});
  }
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
