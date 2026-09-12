import type { Page } from "playwright";

/**
 * Detects (never solves) a CAPTCHA challenge on the current page. reCAPTCHA/hCaptcha
 * exist specifically to stop scripted submissions, and every major ATS we target here
 * (Workday, Greenhouse, Lever, Taleo) prohibits automated/bot submissions in its terms.
 * When this returns true, the caller must stop and hand the application to a human —
 * it must never be paired with an auto-solving service.
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  const iframeHit = await page
    .locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="captcha" i]')
    .count();
  if (iframeHit > 0) return true;

  const siteKeyHit = await page.locator("[data-sitekey], .g-recaptcha, .h-captcha").count();
  if (siteKeyHit > 0) return true;

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /verify (that )?you.{0,15}(human|robot)|complete the captcha/i.test(bodyText);
}
