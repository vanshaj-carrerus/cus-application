import type { Page } from "playwright";
import { JobBoardCredential, type IJobBoardCredential } from "@/lib/models/JobBoardCredential";
import { decryptSecret } from "@/lib/security/crypto";
import { detectBoardFromUrl } from "@/lib/automation/browser";
import { detectAuthWall } from "@/lib/automation/pageState";

const LOGIN_TIMEOUT_MS = 15_000;

/**
 * Finds the candidate's saved login for whatever site `pageUrl` is on: an exact/
 * subdomain hostname match against an OTHER credential (arbitrary ATS/employer
 * site), or a named-board match (LinkedIn, Indeed, ...) via the same hostname map
 * browser.ts already uses for session restoration.
 */
async function findCredentialForUrl(candidateId: string, pageUrl: string): Promise<IJobBoardCredential | null> {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const credentials = await JobBoardCredential.find({ candidateId, status: "ACTIVE" }).select("+passwordEncrypted");

  const hostnameMatch = credentials.find((c) => c.board === "OTHER" && c.hostname && (host === c.hostname || host.endsWith(`.${c.hostname}`)));
  if (hostnameMatch) return hostnameMatch;

  const namedBoard = detectBoardFromUrl(pageUrl);
  if (namedBoard) return credentials.find((c) => c.board === namedBoard) ?? null;

  return null;
}

export interface AutoLoginResult {
  attempted: boolean;
  success: boolean;
  credentialLabel?: string;
}

/**
 * Attempts to clear a login/account wall using a saved credential, if one matches
 * this page's site. Only ever runs when the candidate has explicitly provided
 * these credentials themselves (see /api/portal/credentials) — this never guesses
 * at or reuses credentials for a site the candidate didn't register.
 */
export async function attemptAutoLogin(page: Page, candidateId: string): Promise<AutoLoginResult> {
  const credential = await findCredentialForUrl(candidateId, page.url());
  if (!credential) return { attempted: false, success: false };

  const password = decryptSecret(credential.passwordEncrypted);
  const label = credential.board === "OTHER" ? credential.hostname! : credential.board;

  // Some ATS walls default to "create account" — switch to sign-in mode if a toggle exists.
  const signInToggle = page.locator('a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("Log in"), button:has-text("Log in")').first();
  if ((await signInToggle.count()) > 0 && (await signInToggle.isVisible().catch(() => false))) {
    await signInToggle.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const usernameSelectors = ['input[type="email"]', 'input[name*="email" i]', 'input[name*="username" i]', 'input[autocomplete="username"]'];
  for (const selector of usernameSelectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.fill(credential.boardUsername).catch(() => undefined);
      break;
    }
  }

  const passwordField = page.locator('input[type="password"]').first();
  if ((await passwordField.count()) === 0) {
    // No password field to fill — nothing this function can do here.
    return { attempted: true, success: false, credentialLabel: label };
  }
  await passwordField.fill(password);

  const submitSelectors = ['button:has-text("Sign In")', 'button:has-text("Log In")', 'button:has-text("Continue")', 'button[type="submit"]', 'input[type="submit"]'];
  let clicked = false;
  for (const selector of submitSelectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: LOGIN_TIMEOUT_MS }), locator.click()]);
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    await passwordField.press("Enter").catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
  }

  const stillWalled = await detectAuthWall(page);
  const success = !stillWalled;

  credential.lastUsedAt = new Date();
  if (success) {
    credential.lastVerifiedAt = new Date();
    credential.status = "ACTIVE";
    credential.lastError = undefined;
  } else {
    credential.status = "INVALID";
    credential.lastError = "Automated login attempt did not clear the login/signup wall — check the saved username/password.";
  }
  await credential.save();

  return { attempted: true, success, credentialLabel: label };
}
