import type { Page } from "playwright";

/**
 * Detects a login/account-creation wall blocking the apply flow. Many ATS-hosted
 * apply pages require the candidate to sign in or register an account before the
 * real application form appears — automation can't do that on the candidate's
 * behalf without their real credentials (see lib/models/JobBoardCredential), so
 * hitting one of these means stop and hand off, not guess at a submit button.
 */
export async function detectAuthWall(page: Page): Promise<boolean> {
  const passwordFieldCount = await page.locator('input[type="password"]').count();
  if (passwordFieldCount > 0) return true;

  const url = page.url().toLowerCase();
  if (/login|signin|sign-in|signup|sign-up|register|account\/new|create-account/.test(url)) return true;

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /sign in to (apply|continue)|log in to (apply|continue)|create (an |your )?account to apply|please (sign in|log in|register)|you (must|need to) (sign in|log in|create an account)/i.test(
    bodyText
  );
}

/**
 * Detects a one-time-code / 2FA verification prompt. This is intentionally
 * detect-only, same as CAPTCHA: an OTP exists to prove a human is present at
 * that moment, and reading a candidate's personal inbox to auto-fetch and submit
 * one would defeat that on their behalf. Hitting this always means stop and hand
 * off to the candidate, never attempt to solve it.
 */
export async function detectOtpWall(page: Page): Promise<boolean> {
  const otpFieldCount = await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="verification" i]').count();
  if (otpFieldCount > 0) return true;

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /enter the (code|verification code|otp)|we('ve| have) sent (a code|a verification code|an otp)|check your email for a code|two-factor authentication|verify your identity/i.test(
    bodyText
  );
}

/**
 * Detects an actual submission confirmation (URL or page text). Clicking a button
 * that matches "submit" heuristics is not evidence anything was submitted — some
 * forms silently reject the click (validation failure, unfilled required field,
 * wrong element matched) and leave the candidate on the same step. Only a positive
 * confirmation signal should ever result in marking an Application APPLIED.
 */
export async function detectSuccessConfirmation(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (/thank|confirmation|success|submitted|complete/.test(url)) return true;

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /thank you for (applying|your application|your interest)|application (has been |was |is )?(received|submitted|complete)|we('ve| have) received your application|(your application (has been )?)?submitted successfully/i.test(
    bodyText
  );
}
