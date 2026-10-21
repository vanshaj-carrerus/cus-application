import { env } from "@/lib/env";

/**
 * Vision-based judgment of an apply-flow screenshot, used instead of trusting URL/
 * text heuristics alone for the final "did this actually submit" call. Runs through
 * a sequential chain of vision providers (first one to return a response wins): Gemini
 * first — it is the reliable one — then free OpenRouter models. Returns null (never a
 * thrown error) when every provider fails — callers must fall back to heuristics rather
 * than crash the apply flow over a vision call.
 *
 * Free-tier model slugs get retired without notice (two of ours started returning 404), so
 * every failure is logged with its reason instead of being swallowed silently.
 */

const GEMINI_VISION_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"];

// Free OpenRouter models with image-input support (checked against /api/v1/models), tried in
// order after Gemini. Used by the CAPTCHA fallback in captcha.ts too.
export const VISION_MODELS = ["nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"];

export type ScreenshotDecision = "SUBMITTED" | "RETRY" | "NEEDS_HUMAN" | "FAILED_HARD";

export interface ScreenshotJudgment {
  decision: ScreenshotDecision;
  reasoning: string;
}

const VALID_DECISIONS: ScreenshotDecision[] = ["SUBMITTED", "RETRY", "NEEDS_HUMAN", "FAILED_HARD"];

function parseJsonSafely<T>(raw: string): T | null {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// Total time one vision question may take across every provider and retry. A stalled provider must cost
// seconds, not hold up the whole apply run.
const VISION_BUDGET_MS = 70_000;
const PER_CALL_MS = 25_000;

async function runGeminiVision(screenshotPng: Buffer, prompt: string, deadline: number): Promise<string | null> {
  // GEMINI_API_KEY first, AI_API_KEY (the app's main Google key) as a second quota pool.
  const keys = [env.geminiApiKey, process.env.AI_API_KEY].map((k) => k?.trim()).filter((k): k is string => !!k);
  const data = screenshotPng.toString("base64");

  for (const key of [...new Set(keys)]) {
    for (const model of GEMINI_VISION_MODELS) {
      if (Date.now() > deadline) return null;
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data } }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(PER_CALL_MS),
        });
        if (!res.ok) {
          console.warn(`[vision] gemini ${model} -> HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } catch (err) {
        console.warn(`[vision] gemini ${model} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}

async function runVisionPrompt(screenshotPng: Buffer, prompt: string): Promise<string | null> {
  const deadline = Date.now() + VISION_BUDGET_MS;
  const gemini = await runGeminiVision(screenshotPng, prompt, deadline);
  if (gemini) return gemini;

  if (!env.openrouterApiKey) {
    console.warn("[vision] no provider answered and OPENROUTER_API_KEY is not set");
    return null;
  }

  const imageUrl = `data:image/png;base64,${screenshotPng.toString("base64")}`;

  for (const modelId of VISION_MODELS) {
    if (Date.now() > deadline) break;
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        signal: AbortSignal.timeout(PER_CALL_MS),
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
          temperature: 0.2,
        }),
      });
      if (!res.ok) {
        console.warn(`[vision] openrouter ${modelId} -> HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) continue;
      return content;
    } catch (err) {
      console.warn(`[vision] openrouter ${modelId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

export async function judgeApplicationScreenshot(screenshotPng: Buffer, contextPrompt: string): Promise<ScreenshotJudgment | null> {
  const prompt = `${contextPrompt}

Look at the attached screenshot, taken during an automated job application attempt. Decide what state the application is in and respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "decision": one of "SUBMITTED" | "RETRY" | "NEEDS_HUMAN" | "FAILED_HARD",
  "reasoning": "one sentence explaining what you see and why"
}

Meaning of each decision:
- SUBMITTED: the screenshot clearly shows a confirmation that the application was successfully submitted/received (e.g. a thank-you page, "application received" message).
- RETRY: the screenshot shows a fixable problem — a validation error, a highlighted required field, a form still showing with an error banner — that trying again (re-filling and re-submitting) might resolve.
- NEEDS_HUMAN: the screenshot shows something automation cannot resolve on its own — an unusual custom question, an ambiguous state, or something needing human judgment — but nothing that looks permanently broken.
- FAILED_HARD: the screenshot shows a terminal failure that retrying will not fix (e.g. "this position is no longer accepting applications", an account/permission error, a fundamentally broken page).`;

  const content = await runVisionPrompt(screenshotPng, prompt);
  if (!content) return null;

  const parsed = parseJsonSafely<ScreenshotJudgment>(content);
  if (!parsed || !VALID_DECISIONS.includes(parsed.decision)) return null;
  return parsed;
}

/**
 * Fallback for when the DOM/URL heuristics in formHeuristics.ts can't tell what
 * kind of page this is or can't find a control to click through to the real
 * application form. Used sparingly (only when the free heuristics come up empty)
 * since it costs a vision call — never the primary router.
 */

export type ApplyPageIntent = "JOB_DETAIL" | "APPLICATION_FORM" | "OTHER";

export interface ApplyTargetLocation {
  pageIntent: ApplyPageIntent;
  /** Exact or near-exact visible text of the control to click to reach the application form, if any. */
  controlText: string | null;
  reasoning: string;
}

export async function locateApplyTarget(screenshotPng: Buffer, contextPrompt: string): Promise<ApplyTargetLocation | null> {
  const prompt = `${contextPrompt}

Look at the attached screenshot of a careers/job-board web page. Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "pageIntent": one of "JOB_DETAIL" | "APPLICATION_FORM" | "OTHER",
  "controlText": the exact visible text of the button or link to click to start/continue the application, or null if there isn't one,
  "reasoning": "one sentence explaining what you see"
}

Meaning of each pageIntent:
- JOB_DETAIL: this shows a job posting (title, responsibilities, requirements) with a way to start applying, but no actual form fields to fill in yet.
- APPLICATION_FORM: this already shows fillable form fields (name, email, resume upload, etc.) or a "create account" step that gates the form.
- OTHER: neither of the above (e.g. a search results list, an error page, a captcha, an already-submitted confirmation).

If pageIntent is JOB_DETAIL, controlText should be the exact text of the button/link that opens the application (e.g. "Apply Now", "Apply for this Job", "I'm Interested", "Quick Apply"). Prefer the most prominent/primary one if there are several. Use the text exactly as rendered, including capitalization.`;

  const content = await runVisionPrompt(screenshotPng, prompt);
  if (!content) return null;

  const parsed = parseJsonSafely<ApplyTargetLocation>(content);
  if (!parsed || !["JOB_DETAIL", "APPLICATION_FORM", "OTHER"].includes(parsed.pageIntent)) return null;
  return parsed;
}

/**
 * Used when the zero-cost heuristics have run out of ideas mid-application (no Next/Submit
 * control found, or the page isn't a form but isn't a confirmation either). Looks at the
 * screen like a person would and names the one control to click next.
 */
export type NextActionKind = "CLICK" | "DONE" | "NEEDS_HUMAN";

export interface NextActionSuggestion {
  action: NextActionKind;
  /** Exact visible text of the control to click when action is CLICK. */
  controlText: string | null;
  reasoning: string;
}

export async function suggestNextClick(screenshotPng: Buffer, contextPrompt: string, controls?: string[]): Promise<NextActionSuggestion | null> {
  const controlList = controls?.length
    ? `\nThese are ALL the clickable controls currently visible on the page, in reading order. If you answer CLICK, "controlText" MUST be copied exactly from this list:\n${controls.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
    : "";
  const prompt = `${contextPrompt}

The automation is stuck partway through a job application and cannot tell what to do next. Look at the attached screenshot and respond with ONLY a JSON object (no markdown fences, no commentary):${controlList}
{
  "action": one of "CLICK" | "DONE" | "NEEDS_HUMAN",
  "controlText": the exact visible text of the single button or link to click next, or null,
  "reasoning": "one sentence explaining what you see"
}

- CLICK: there is a control that moves the application forward — "Apply", "Apply Now", "Easy Apply", "Continue", "Next", "Review", "Submit application", "Apply on company site", "Apply on the website", "I'm interested", or a button that dismisses a blocking pop-up/cookie banner so the page underneath can be used. Give its text exactly as rendered. If ANY control starts or continues the application, choose CLICK — even when the page text also mentions other ways to apply (such as emailing a resume).
- DONE: the page shows the application was submitted/received (thank-you / confirmation message).
- NEEDS_HUMAN: ONLY when no control on the page can move the application forward — an error/blocked page, a CAPTCHA or identity check, or a question you cannot answer from a resume. A job description with an Apply-style control is never NEEDS_HUMAN. A sign-in screen is not NEEDS_HUMAN either if a "Sign in", "Continue with email" or similar control is present — choose CLICK on it.

Never choose controls that log out, delete, save-for-later, share, report, or go back. Never choose a control that applies or signs in "with LinkedIn", "with Indeed", "with Google", "with Facebook", "with Apple" or "with Microsoft" — that needs somebody's account on another site; pick the plain Apply / email option instead.`;

  const content = await runVisionPrompt(screenshotPng, prompt);
  if (!content) return null;

  const parsed = parseJsonSafely<NextActionSuggestion>(content);
  if (!parsed || !["CLICK", "DONE", "NEEDS_HUMAN"].includes(parsed.action)) return null;
  return parsed;
}
