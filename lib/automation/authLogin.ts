import type { Page } from "playwright";
import { randomBytes } from "crypto";
import { JobBoardCredential, type IJobBoardCredential } from "@/lib/models/JobBoardCredential";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { detectBoardFromUrl } from "@/lib/automation/browser";
import { detectAuthWall, detectOtpWall, markOtpInputs } from "@/lib/automation/pageState";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { fetchVerificationCode } from "@/lib/automation/otpRetriever";

const LOGIN_TIMEOUT_MS = 15_000;

/**
 * Finds the candidate's saved login for whatever site `pageUrl` is on, most
 * specific match first:
 *   1. an OTHER credential whose hostname matches this exact site
 *   2. a named-board credential (LinkedIn, Indeed, ...) via the same hostname map
 *      browser.ts uses for session restoration
 *   3. the candidate's "default" credential (OTHER with no hostname) — one login
 *      they've said to try everywhere, unless something more specific overrides it
 */
export async function findCredentialForUrl(candidateId: string, pageUrl: string): Promise<IJobBoardCredential | null> {
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
  if (namedBoard) {
    const namedMatch = credentials.find((c) => c.board === namedBoard);
    if (namedMatch) return namedMatch;
  }

  // The candidate's "use everywhere" login. Looked up regardless of status: older versions marked it INVALID
  // whenever any single site refused it, which says nothing about whether it is right for the next site.
  const general = await JobBoardCredential.findOne({ candidateId, board: "OTHER", $or: [{ hostname: { $exists: false } }, { hostname: null }, { hostname: "" }] }).select("+passwordEncrypted");
  return general ?? null;
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
  const label = credential.board === "OTHER" ? (credential.hostname ?? "default") : credential.board;

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

const SIGNUP_NAME_SELECTORS = ['input[autocomplete="name"]', 'input[name="name"]', 'input[name*="full_name" i]', 'input[name*="fullname" i]'];
const SIGNUP_FIRST_NAME_SELECTORS = ['input[autocomplete="given-name"]', 'input[name*="first_name" i]', 'input[name*="firstname" i]'];
const SIGNUP_LAST_NAME_SELECTORS = ['input[autocomplete="family-name"]', 'input[name*="last_name" i]', 'input[name*="lastname" i]'];
const SIGNUP_EMAIL_SELECTORS = ['input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="username"]'];
const SIGNUP_PHONE_SELECTORS = ['input[type="tel"]', 'input[name*="phone" i]'];
const SIGNUP_CONFIRM_PASSWORD_SELECTORS = [
  'input[name*="confirm" i][type="password"]',
  'input[name*="verify" i][type="password"]',
  'input[autocomplete="new-password"]:not(:first-of-type)',
];

async function fillFirstVisible(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.fill(value).catch(() => undefined);
      return true;
    }
  }
  return false;
}

export interface AutoSignupResult {
  attempted: boolean;
  success: boolean;
  loginId?: string;
}

/**
 * Registers a brand-new account on the ATS/employer site when the apply flow hits
 * a login wall and no saved credential matches — many career sites require an
 * account before the application form appears, and manually hunting down a
 * recruiter to create one for every candidate/site pair doesn't scale. Only runs
 * when the candidate has an on-file email to register with; the generated password
 * is saved back as a JobBoardCredential (encrypted, same as a manually-entered one)
 * so a later attempt can sign back in via attemptAutoLogin instead of registering again.
 */
export async function attemptAutoSignup(
  page: Page,
  candidateId: string,
  candidate: { name: string; email?: string; phone?: string }
): Promise<AutoSignupResult> {
  if (!candidate.email) return { attempted: false, success: false };

  // Never register accounts on aggregator job boards (LinkedIn, Indeed, ...). Opening accounts in a
  // candidate's name through automation breaks those sites' terms and risks the candidate's identity
  // on them; employer/ATS sites are different — an account there is a normal part of applying.
  if (detectBoardFromUrl(page.url())) return { attempted: false, success: false };

  const signupToggle = page
    .locator(
      'a:has-text("Sign up"), button:has-text("Sign up"), a:has-text("Create account"), button:has-text("Create account"), a:has-text("Register"), button:has-text("Register")'
    )
    .first();
  if ((await signupToggle.count()) > 0 && (await signupToggle.isVisible().catch(() => false))) {
    await signupToggle.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const passwordField = page.locator('input[type="password"]').first();
  if ((await passwordField.count()) === 0) return { attempted: false, success: false };

  const password = randomBytes(9).toString("base64url");
  const [firstName, ...rest] = candidate.name.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  await fillFirstVisible(page, SIGNUP_NAME_SELECTORS, candidate.name);
  await fillFirstVisible(page, SIGNUP_FIRST_NAME_SELECTORS, firstName);
  await fillFirstVisible(page, SIGNUP_LAST_NAME_SELECTORS, lastName);
  await fillFirstVisible(page, SIGNUP_EMAIL_SELECTORS, candidate.email);
  if (candidate.phone) await fillFirstVisible(page, SIGNUP_PHONE_SELECTORS, candidate.phone);

  await passwordField.fill(password);
  await fillFirstVisible(page, SIGNUP_CONFIRM_PASSWORD_SELECTORS, password);

  const termsCheckbox = page.locator('input[type="checkbox"][name*="terms" i], input[type="checkbox"][name*="agree" i]').first();
  if ((await termsCheckbox.count()) > 0 && !(await termsCheckbox.isChecked().catch(() => true))) {
    await termsCheckbox.check().catch(() => undefined);
  }

  const submitSelectors = [
    'button:has-text("Sign Up")',
    'button:has-text("Create Account")',
    'button:has-text("Register")',
    'button:has-text("Continue")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];
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

  let host: string | undefined;
  try {
    host = new URL(page.url()).hostname.toLowerCase();
  } catch {
    host = undefined;
  }

  if (success && host) {
    await JobBoardCredential.findOneAndUpdate(
      { candidateId, board: "OTHER", hostname: host },
      {
        $set: {
          boardUsername: candidate.email,
          passwordEncrypted: encryptSecret(password),
          status: "ACTIVE",
          lastUsedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        $unset: { lastError: 1 },
      },
      { upsert: true }
    );
  }

  return { attempted: true, success, loginId: candidate.email };
}

const OTP_SUBMIT_SELECTORS = [
  'button:has-text("Verify")',
  'button:has-text("Confirm")',
  'button:has-text("Continue")',
  'button:has-text("Submit")',
  'button[type="submit"]',
  'input[type="submit"]',
];

const RESEND_CODE = /resend|send (the |a )?(code|it) again|send again|didn'?t (get|receive)|new code/i;
const RESEND_WAIT_MS = 60_000;

export interface OtpChallengeResult {
  attempted: boolean;
  success: boolean;
  from?: string;
  /** Why it failed, in terms a recruiter can act on. */
  reason?: string;
}

/**
 * Clears an email-verification (one-time-code) step by reading the code from the candidate's own
 * OAuth-connected inbox and submitting it. Runs right after a sign-in/sign-up the automation just
 * performed on the candidate's behalf, so the code we wait for is the one that flow just triggered.
 * Handles a single code field and the one-box-per-digit layout; if nothing arrives it asks the site
 * to resend once before giving up.
 */
export async function attemptOtpChallenge(page: Page, candidateId: string): Promise<OtpChallengeResult> {
  let host: string;
  try {
    host = new URL(page.url()).hostname.toLowerCase();
  } catch {
    return { attempted: false, success: false, reason: "page has no URL" };
  }

  const inputCount = await markOtpInputs(page);
  if (inputCount === 0) return { attempted: false, success: false, reason: "no code field on the page" };
  const otpInputs = page.locator("[data-cus-otp]");

  const mailbox = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: candidateId, status: { $ne: "DISCONNECTED" } });
  if (!mailbox) {
    return { attempted: true, success: false, reason: "the site asked for an email code but this candidate has no Gmail connected (Portal → Email Access)" };
  }

  // The code was sent when we submitted the sign-in/sign-up moments ago; look a few minutes back so a
  // code that landed just before we noticed the prompt still counts.
  let since = new Date(Date.now() - 3 * 60_000);
  let found = await fetchVerificationCode({ candidateId, targetHost: host, since });

  if (!found.code) {
    const resend = page.getByRole("button", { name: RESEND_CODE }).or(page.getByRole("link", { name: RESEND_CODE })).first();
    if ((await resend.count()) > 0 && (await resend.isVisible().catch(() => false))) {
      await resend.click().catch(() => undefined);
      since = new Date(Date.now() - 15_000);
      found = await fetchVerificationCode({ candidateId, targetHost: host, since, timeoutMs: RESEND_WAIT_MS });
    }
  }
  if (!found.code) {
    return { attempted: true, success: false, reason: `no verification code reached ${mailbox.emailAddress} in time (is that the address the account was registered with?)` };
  }
  const code = found.code;

  if (inputCount > 1 && inputCount >= code.length) {
    // One box per character: focus the first and type, so the page's own auto-advance moves along.
    await otpInputs.first().click().catch(() => undefined);
    await page.keyboard.type(code, { delay: 60 });
  } else {
    await otpInputs.first().fill(code).catch(() => undefined);
  }

  let clicked = false;
  await page.waitForTimeout(500);
  if (await detectOtpWall(page)) {
    for (const selector of OTP_SUBMIT_SELECTORS) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: LOGIN_TIMEOUT_MS }), locator.click()]);
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await otpInputs.last().press("Enter").catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
    }
  }
  await page.waitForTimeout(1_000);

  const stillOtp = await detectOtpWall(page);
  return stillOtp
    ? { attempted: true, success: false, from: found.from, reason: "the site rejected the verification code" }
    : { attempted: true, success: true, from: found.from };
}
