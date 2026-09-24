import { env } from "@/lib/env";

/**
 * Vision-based judgment of an apply-flow screenshot, used instead of trusting URL/
 * text heuristics alone for the final "did this actually submit" call. Runs through
 * a sequential chain of free OpenRouter vision models (first one to return a valid
 * response wins) with a null return (never a thrown error) when the key is missing
 * or every model in the chain fails — callers must fall back to heuristics rather
 * than crash the apply flow over a vision call.
 */

// Free OpenRouter models with image-input support, tried in order until one
// returns a parseable, valid response.

const VISION_MODELS = ["inclusionai/ling-3.0-flash-vl:free", "qwen/qwen3.8-27b:free", "google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"];

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

async function runVisionPrompt(screenshotPng: Buffer, prompt: string): Promise<string | null> {
  if (!env.openrouterApiKey) return null;

  const imageUrl = `data:image/png;base64,${screenshotPng.toString("base64")}`;

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
          temperature: 0.2,
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) continue;
      return content;
    } catch {
      // try next model in the chain
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
