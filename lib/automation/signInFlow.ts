import type { Locator, Page } from "playwright";
import { randomBytes } from "crypto";
import { JobBoardCredential } from "@/lib/models/JobBoardCredential";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { detectBoardFromUrl } from "@/lib/automation/browser";
import { detectOtpWall, findEmailChooser, hasEmailOnlyGate } from "@/lib/automation/pageState";
import { attemptOtpChallenge, findCredentialForUrl } from "@/lib/automation/authLogin";
import { detectCaptcha, solveCaptcha } from "@/lib/automation/captcha";
import { saveBoardSession } from "@/lib/automation/browser";
import { suggestNextClick } from "@/lib/adapters/visionAdapter";
import { findClickableByText, listClickables } from "@/lib/automation/formHeuristics";

/**
 * Gets past a "sign in / create an account to continue" wall the way a person would, one screen at a
 * time, by reading what the page currently shows:
 *
 *   sign-in options  -> "Continue with email" (never Google/Apple/Facebook/LinkedIn/Microsoft)
 *   email only       -> the candidate's email, then Continue
 *   password screen  -> saved login, or — on an employer's own site — a new account
 *   code screen      -> the code from the candidate's connected Gmail
 *
 * The account email is the connected Gmail address (that is where the code will land). The password
 * is the candidate's saved login for that site; for a new account it is the candidate's own default
 * login if they set one, otherwise a generated one — saved back (encrypted) for the next run.
 * Job boards (LinkedIn, Indeed, ...) are never registered with; they need the candidate's own login.
 */

const MAX_STEPS = 12;
const SETTLE_MS = 1_200;
const FLOW_TIMEOUT_MS = 4 * 60_000;

export interface SignInResult {
  success: boolean;
  attempted: boolean;
  method?: "saved_login" | "email_code" | "new_account";
  loginId?: string;
  /** What was done, in order — logged on the attempt for the recruiter. */
  steps: string[];
  reason?: string;
  failure?: "login" | "otp";
}

interface PageSignInState {
  chooser: Locator | null;
  /** A lone "Sign in (to apply)" button when the wall shows no fields yet. */
  entry: Locator | null;
  email: Locator | null;
  password: Locator | null;
  confirmPassword: Locator | null;
  otp: boolean;
  signupForm: boolean;
  emailGate: boolean;
  /** Visible text says the credentials / account are wrong or missing. */
  error: "bad_credentials" | "no_account" | "account_exists" | null;
  /** A bot/identity check page ("quick security check", "verify you're human") — not a password problem. */
  challenge: boolean;
}

const CHALLENGE_URL = /checkpoint|\/challenge|captcha|security[-_]?check|verify[-_]?identity|unusual[-_]?activity/i;
const CHALLENGE_TEXT = /(quick )?security check|verify (that )?you('| a)re (a )?(human|real person|not a robot)|unusual (sign[\s-]?in )?activity|confirm (that )?it'?s you|suspicious (activity|login)|are you a robot/i;

const EMAIL_FIELD = 'input[type="email"], input[autocomplete="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[name*="username" i], input[name*="login" i]';
// A social/SSO login button: "Continue with Google", "Sign in with Apple", a bare provider name, SSO.
// Deliberately NOT a bare "linkedin" match — LinkedIn's own "Already on LinkedIn? Sign in" link is a normal one.
const SOCIAL = /(with|using|via|through)\s+(google|apple|facebook|linkedin|microsoft|github|twitter|x\b|yahoo|amazon)|^\s*(google|apple|facebook|microsoft|github)\s*$|\b(sso|saml|okta|single sign)\b/i;
// A lone "Sign in" / "Sign in to Apply →" button: the first step of a wall that shows no fields yet.
const ENTRY_NAME = /^\s*(sign[\s-]?in|log[\s-]?in|login)(\s+(or|and)\s+(sign[\s-]?up|register|join|create (an )?account))?(\s+(to|and)\s+(apply|continue))?(\s+(now|here))?\s*[→>»›]*\s*$|^\s*(sign[\s-]?up|register|join)\s+(or|and)\s+(sign[\s-]?in|log[\s-]?in)\s*$/i;
const SUBMIT_NAME = /^\s*(continue|next|sign[\s-]?in|log[\s-]?in|login|submit|send( me)?( a| the| your)?( verification| login| sign[\s-]?in)? (code|link)|get( a| your)? code|verify|create( an| your)? account|sign[\s-]?up|register|join|go)\b/i;
const CONSENT_LABEL = /\b(agree|consent|accept|acknowledge|have read)\b.*\b(privacy|terms|policy|conditions|data)\b|^\s*i agree\s*$/i;

function challengeReason(host: string): string {
  const site = host.replace(/^(www|in)\./, "");
  return `${site} accepted the login but is asking for a security check (a bot/identity puzzle) that automation can't pass from this browser. Sign in to ${site} once as a person to save the session — run: npm run board-login -- <candidateId> ${detectBoardFromUrl(`https://${host}/`) ?? "LINKEDIN"} — after that the worker reuses it`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function firstVisible(page: Page, selector: string): Promise<Locator | null> {
  const all = page.locator(selector);
  const n = Math.min(await all.count(), 8);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if ((await el.isVisible().catch(() => false)) && (await el.isEditable().catch(() => false))) return el;
  }
  return null;
}

async function readState(page: Page): Promise<PageSignInState> {
  const password = await firstVisible(page, 'input[type="password"]');
  const allPasswords = page.locator('input[type="password"]:visible');
  const confirmPassword =
    (await allPasswords.count()) > 1 ? allPasswords.nth(1) : await firstVisible(page, 'input[type="password"][name*="confirm" i], input[type="password"][name*="verify" i], input[type="password"][name*="repeat" i]');
  const email = await firstVisible(page, EMAIL_FIELD);
  const otp = await detectOtpWall(page);
  const chooser = email || password ? null : await findEmailChooser(page);
  let entry: Locator | null = null;
  if (!email && !password && !otp && !chooser) {
    for (const role of ["button", "link"] as const) {
      const control = page.getByRole(role, { name: ENTRY_NAME }).first();
      if ((await control.count()) > 0 && (await control.isVisible().catch(() => false))) {
        entry = control;
        break;
      }
    }
  }
  // An email box on a sign-in/auth address is an email-first wall even when its heading uses unfamiliar words.
  const emailGate = !password && !otp && !!email && ((await hasEmailOnlyGate(page)) || LOGIN_URL.test(page.url()));

  const text = ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 6000);
  const hasNameFields = !!(await firstVisible(page, 'input[autocomplete="given-name"], input[name*="first" i][type="text"], input[name*="firstname" i], input[autocomplete="name"]'));

  // Sign-up vs sign-in is decided by the password form itself — its own buttons and the page heading —
  // never by words elsewhere on the page: a sign-in page almost always carries a "Create account" link.
  const form = password
    ? await password
        .evaluate((el) => {
          (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
          const scope = el.closest("form") ?? document.body;
          return {
            buttons: Array.from(scope.querySelectorAll("button, input[type=submit]")).map((b) => (b.textContent || (b as HTMLInputElement).value || "").trim()),
            headings: Array.from(document.querySelectorAll("h1, h2, [role=heading]")).map((h) => (h.textContent ?? "").trim()),
            newPassword: (el as HTMLInputElement).autocomplete === "new-password",
          };
        })
        .catch(() => null)
    : null;
  const SIGNUP = /create|sign[\s-]?up|register|join/i;
  const LOGIN = /sign[\s-]?in|log[\s-]?in|welcome back/i;
  const buttonSignup = !!form?.buttons.some((b) => SIGNUP.test(b) && !LOGIN.test(b));
  const buttonLogin = !!form?.buttons.some((b) => LOGIN.test(b) && !SIGNUP.test(b));
  const headingSignup = !!form?.headings.some((h) => SIGNUP.test(h) && !LOGIN.test(h));
  const signupForm = !!password && (!!confirmPassword || !!form?.newPassword || buttonSignup || (!buttonLogin && (hasNameFields || headingSignup)));

  let error: PageSignInState["error"] = null;
  if (/already (have an account|registered|exists?|in use|taken)|account (with this email )?already exists|email.{0,20}already/i.test(text)) error = "account_exists";
  else if (/no account (found|exists)|couldn'?t find (an )?account|we (can'?t|couldn'?t) find|not registered|doesn'?t exist|does not exist/i.test(text)) error = "no_account";
  else if (/incorrect|invalid (e-?mail|password|credentials|login)|wrong (password|e-?mail)|didn'?t match|do(es)? not match|authentication failed|unable to (sign|log) ?in/i.test(text)) error = "bad_credentials";

  const challenge = !password && !otp && (CHALLENGE_URL.test(page.url()) || CHALLENGE_TEXT.test(text.slice(0, 1500)));

  return { chooser, entry, email, password, confirmPassword, otp, signupForm, emailGate, error, challenge };
}

/**
 * After submitting a form, the next screen often arrives a few seconds later (single-page apps, bot
 * checks). Reading the page too early mistakes "still loading" for "rejected". Wait until the URL
 * changes, the password box goes, a code box or a challenge appears, or an error shows — or time runs out.
 */
async function waitForChange(page: Page, urlBefore: string, timeoutMs = 20_000): Promise<PageSignInState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readState(page);
  while (Date.now() < deadline) {
    if (page.url() !== urlBefore || !state.password || state.otp || state.challenge || state.error) break;
    await page.waitForTimeout(700);
    state = await readState(page);
  }
  return state;
}

// An address that is a sign-in / registration page (not merely one that contains "auth" inside another word).
const LOGIN_URL = /\/(log[-_]?in|sign[-_]?in|sign[-_]?up|register|registration|auth|authorize|account\/login|session\/new|identity)(\b|[/?;#])|[?&](login|signin)=|\/oauth\/|\/checkpoint\//i;

/** Polls (up to ~15s) for a sign-in page to render something we can act on; true as soon as it does. */
async function waitForSignInForm(page: Page): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const s = await readState(page);
    if (s.password || s.otp || s.chooser || s.emailGate || s.entry || s.challenge || s.email) return true;
    if (!LOGIN_URL.test(page.url())) return true; // it moved on to a real page
  }
  return false;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

/** Clicks the form's own primary button (never a social-login one); falls back to Enter in the field. */
async function submitFrom(page: Page, field: Locator) {
  const form = field.locator("xpath=ancestor::form[1]");
  const root = (await form.count()) > 0 ? form : page;
  const candidates = [
    root.getByRole("button", { name: SUBMIT_NAME }).filter({ hasNotText: SOCIAL }).first(),
    root.locator('button[type="submit"], input[type="submit"]').filter({ hasNotText: SOCIAL }).first(),
  ];
  for (const button of candidates) {
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) {
      await Promise.allSettled([page.waitForLoadState("domcontentloaded", { timeout: 15_000 }), button.click()]);
      return;
    }
  }
  await field.press("Enter").catch(() => undefined);
}

async function fillField(field: Locator | null, value: string | undefined): Promise<boolean> {
  if (!field || !value) return false;
  await field.click({ timeout: 3_000 }).catch(() => undefined);
  await field.fill(value, { timeout: 5_000 }).catch(() => undefined);
  return (await field.inputValue().catch(() => "")) === value;
}

function generatePassword(): string {
  // Meets the usual ATS rules (upper, lower, digit, symbol, 16+ chars) whatever the site demands.
  return `${randomBytes(9).toString("base64url")}Aa1!`;
}

async function saveCredential(candidateId: string, host: string, loginId: string, password: string) {
  await JobBoardCredential.findOneAndUpdate(
    { candidateId, board: "OTHER", hostname: host },
    {
      $set: { boardUsername: loginId, passwordEncrypted: encryptSecret(password), status: "ACTIVE", lastUsedAt: new Date(), lastVerifiedAt: new Date() },
      $unset: { lastError: 1 },
    },
    { upsert: true }
  );
}

async function switchToSignup(page: Page): Promise<boolean> {
  const toggle = page
    .getByRole("link", { name: /sign[\s-]?up|create (an |your )?account|register|new (user|here)/i })
    .or(page.getByRole("button", { name: /sign[\s-]?up|create (an |your )?account|register/i }))
    .filter({ hasNotText: SOCIAL })
    .first();
  if ((await toggle.count()) === 0 || !(await toggle.isVisible().catch(() => false))) return false;
  await toggle.click().catch(() => undefined);
  await settle(page);
  return true;
}

async function switchToLogin(page: Page): Promise<boolean> {
  const toggle = page
    .getByRole("link", { name: /sign[\s-]?in|log[\s-]?in|already (have|a member)/i })
    .or(page.getByRole("button", { name: /sign[\s-]?in|log[\s-]?in/i }))
    .filter({ hasNotText: SOCIAL })
    .first();
  if ((await toggle.count()) === 0 || !(await toggle.isVisible().catch(() => false))) return false;
  await toggle.click().catch(() => undefined);
  await settle(page);
  return true;
}

export async function passLoginWall(page: Page, candidateId: string, candidate: { name: string; email?: string; phone?: string }): Promise<SignInResult> {
  const steps: string[] = [];
  const fail = (reason: string, failure: "login" | "otp" = "login", attempted = steps.length > 0): SignInResult => ({ success: false, attempted, steps, reason, failure });

  const host = hostOf(page.url());
  const isBoard = !!detectBoardFromUrl(page.url());

  const saved = await findCredentialForUrl(candidateId, page.url());
  const savedPassword = saved ? decryptSecret(saved.passwordEncrypted) : undefined;
  // The candidate's "use everywhere" login (no site on it) vs one saved for this site or board. Only a
  // site-specific login is judged by what this one site says about it: a general login being refused
  // by one site says nothing about the others, so it is never marked invalid here.
  const savedIsGeneral = !!saved && saved.board === "OTHER" && !saved.hostname;

  // Codes land in the connected Gmail, so the address typed into a site must be that mailbox — except
  // when a login saved for this very site names its own email.
  const mailbox = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: candidateId, status: { $ne: "DISCONNECTED" } });
  const accountEmail = (saved && !savedIsGeneral ? saved.boardUsername : undefined) ?? mailbox?.emailAddress ?? candidate.email;

  // Any status: a general login that one site refused (older versions marked it INVALID) is still the
  // candidate's chosen password for new accounts elsewhere.
  const defaultCredential = await JobBoardCredential.findOne({ candidateId, board: "OTHER", $or: [{ hostname: { $exists: false } }, { hostname: null }, { hostname: "" }] }).select("+passwordEncrypted");
  const signupPassword = defaultCredential ? decryptSecret(defaultCredential.passwordEncrypted) : generatePassword();
  const signupPasswordSource = defaultCredential ? "the candidate's own default password" : "a generated password";

  let method: SignInResult["method"];
  let usedPassword: string | undefined;
  let passwordTries = 0;
  let emailSubmits = 0;
  let signupAttempts = 0;
  let entryClicks = 0;
  let aiNudges = 0;
  let challengeTried = false;

  // Safety net for screens none of the rules above recognise: show the AI the real clickable controls and
  // press the one it names — never a login through another site's account.
  const aiNudge = async (why: string): Promise<boolean> => {
    if (aiNudges >= 3) return false;
    aiNudges++;
    const shot = await page.screenshot().catch(() => null);
    if (!shot) return false;
    const suggestion = await suggestNextClick(shot, "This is an automated sign-in or account step of a job application, done on the candidate's behalf.", await listClickables(page));
    if (!suggestion || suggestion.action !== "CLICK" || !suggestion.controlText || SOCIAL.test(suggestion.controlText)) return false;
    const control = await findClickableByText(page, suggestion.controlText);
    if (!control) return false;
    await Promise.allSettled([page.waitForLoadState("domcontentloaded", { timeout: 15_000 }), control.click()]);
    steps.push(`clicked "${suggestion.controlText}" on the AI's advice (${why})`);
    await settle(page);
    return true;
  };
  let loginRejected = false;
  let lastSignature = "";
  const deadline = Date.now() + FLOW_TIMEOUT_MS;

  for (let step = 0; step < MAX_STEPS && Date.now() < deadline; step++) {
    const s = await readState(page);

    const wallGone = !s.challenge && !s.password && !s.otp && !s.chooser && !s.emailGate && !s.entry;

    // "No wall" is only believable if the page is no longer a sign-in page. Slow single-page apps (Indeed's login,
    // for one) show nothing for several seconds, and an empty page looks exactly like a cleared wall — reporting
    // success there would also save a logged-out session as the candidate's login. Give such a page time to
    // render its form, and don't call it cleared while its address is still a login/auth page.
    if (wallGone && steps.length > 0 && LOGIN_URL.test(page.url())) {
      const patient = await waitForSignInForm(page);
      if (patient) continue;
      return fail(`the sign-in page at ${hostOf(page.url())} never showed a form (still on ${page.url().slice(0, 70)})`);
    }
    if (wallGone) {
      if (steps.length === 0) {
        // A wall we don't recognise: let the AI look at the real controls and name the one to press.
        if (await aiNudge("no sign-in screen recognised")) continue;
        return { success: false, attempted: false, steps, reason: "no sign-in controls found on the page" };
      }
      if (method === "new_account" && usedPassword && accountEmail) await saveCredential(candidateId, host, accountEmail, usedPassword);
      // Signed in on a job board: keep the session (cookies) so the next run starts already signed in.
      const board = detectBoardFromUrl(page.url());
      // Only when we really are past the login: a session saved from a logged-out page would be a lie.
      if (board && steps.length > 0 && !LOGIN_URL.test(page.url()) && (method === "saved_login" || method === "new_account" || steps.some((x) => /verification code/.test(x)))) {
        const loginId = savedIsGeneral || !saved ? (saved?.boardUsername ?? accountEmail) : saved.boardUsername;
        await saveBoardSession(candidateId, board, page.context(), loginId ?? "", usedPassword ?? savedPassword ?? "").catch(() => undefined);
        steps.push(`saved the ${board} session for next time`);
      }
      if (method === "saved_login" && saved && !savedIsGeneral) {
        saved.lastUsedAt = new Date();
        saved.lastVerifiedAt = new Date();
        saved.status = "ACTIVE";
        saved.lastError = undefined;
        await saved.save();
      }
      return { success: true, attempted: true, method: method ?? "email_code", loginId: accountEmail, steps };
    }

    // A screen we've already acted on that didn't change means we're stuck — stop rather than loop.
    // (Our own progress counts as movement: after a refused login we are about to try something different
    // on a page that looks exactly the same.)
    const signature = [loginRejected, passwordTries, signupAttempts, entryClicks, emailSubmits, !!s.chooser, !!s.entry, !!s.email, !!s.password, s.otp, s.signupForm, s.emailGate, page.url()].join("|");
    if (signature === lastSignature && step > 0 && !s.otp) {
      if (s.error === "bad_credentials") break;
      if (step > 1) {
        if (await aiNudge("the page did not move on")) continue;
        return fail(`the page did not move on after the last step (still on ${page.url().slice(0, 80)})`);
      }
    }
    lastSignature = signature;

    // 0) A bot / identity check. If it is a CAPTCHA we know how to solve, solve it; otherwise say so plainly.
    if (s.challenge) {
      if (!challengeTried && (await detectCaptcha(page))) {
        challengeTried = true;
        const solved = await solveCaptcha(page);
        steps.push(solved.solved ? "solved the site's CAPTCHA" : `the site's CAPTCHA could not be solved (${solved.message})`);
        if (solved.solved) {
          await settle(page);
          continue;
        }
      }
      return fail(challengeReason(host), "login");
    }

    // 1) Code screen
    if (s.otp) {
      const otp = await attemptOtpChallenge(page, candidateId);
      if (!otp.success) return fail(otp.reason ?? "the verification code step failed", "otp");
      steps.push(`entered the verification code from ${mailbox?.emailAddress ?? "the candidate's Gmail"}${otp.from ? ` (sent by ${otp.from})` : ""}`);
      method ??= "email_code";
      await settle(page);
      continue;
    }

    // 2) Sign-in options screen -> "Continue with email"
    if (s.chooser) {
      await s.chooser.click().catch(() => undefined);
      steps.push('chose "Continue with email"');
      await settle(page);
      continue;
    }

    // 2b) A lone "Sign in to Apply" button: press it to reach the actual form
    if (s.entry) {
      if (entryClicks >= 2) return fail("clicking the sign-in button did not open a sign-in form");
      entryClicks++;
      const label = (await s.entry.innerText().catch(() => "")).replace(/\s+/g, " ").trim() || "Sign in";
      await Promise.allSettled([page.waitForLoadState("domcontentloaded", { timeout: 15_000 }), s.entry.click()]);
      steps.push(`clicked "${label}"`);
      await settle(page);
      continue;
    }

    // 3) Password screen: sign in, or create an account
    if (s.password) {
      const wantsSignup = s.signupForm;

      if (!wantsSignup) {
        // ── sign in ──
        if (!savedPassword || loginRejected) {
          if (!isBoard && (await switchToSignup(page))) {
            steps.push(loginRejected ? "the saved password was not accepted here — switched to Create account" : "no saved login for this site — switched to Create account");
            continue;
          }
          return fail(isBoard ? "this job board needs the candidate's own login saved on the candidate portal (job boards can't be auto-registered)" : "no saved login for this site and no way to create an account here");
        }
        if (passwordTries >= 1) return fail(`the saved login for ${host} was rejected — update the password on the candidate portal`);
        passwordTries++;
        const loginEmail = savedIsGeneral ? saved!.boardUsername : accountEmail;
        if (s.email) await fillField(s.email, loginEmail);
        if (!(await fillField(s.password, savedPassword))) return fail("could not type into the password field");
        steps.push(`signed in as ${loginEmail} with the saved password`);
        method = "saved_login";
        usedPassword = savedPassword;
        const urlBefore = page.url();
        await submitFrom(page, s.password);
        await settle(page);
        const after = await waitForChange(page, urlBefore);
        if (after.challenge) {
          // The login was ACCEPTED; the site now wants proof of a human. That's not a password problem.
          if (saved && !savedIsGeneral) {
            saved.lastError = undefined;
            await saved.save();
          }
          return fail(challengeReason(host), "login");
        }
        // Still on a password screen after submitting one = refused, whether or not the page says so.
        if (after.password && !after.otp) {
          if (saved && !savedIsGeneral) {
            saved.status = "INVALID";
            saved.lastError = "The site rejected the saved password during an automated sign-in.";
            await saved.save();
            return fail(`the site rejected the saved password for ${accountEmail}`);
          }
          // The candidate's general login isn't an account on this site — leave it be and register instead.
          loginRejected = true;
          steps.push("the general saved login is not an account on this site");
        }
        continue;
      }

      // ── create an account ──
      if (isBoard) {
        // A job board's "Join now" page: we never register there, but its "Sign in" link is right on the page.
        if (savedPassword && !loginRejected && (await switchToLogin(page))) {
          steps.push("this is the board's Join page — switched to Sign in");
          continue;
        }
        return fail(
          savedPassword
            ? `${host} did not accept the saved login — save the candidate's own ${host.replace(/^www\./, "").split(".")[0]} email and password under Job Board Logins`
            : "this job board needs the candidate's own login saved on the candidate portal (job boards can't be auto-registered)"
        );
      }
      if (!accountEmail) return fail("no email address on file (and no Gmail connected) to create an account with");
      if (signupAttempts >= 1) return fail("account creation did not go through");
      signupAttempts++;

      const [firstName, ...rest] = candidate.name.trim().split(/\s+/);
      const lastName = rest.join(" ") || firstName;
      await fillField(await firstVisible(page, 'input[autocomplete="given-name"], input[name*="first" i][type="text"], input[name*="firstname" i]'), firstName);
      await fillField(await firstVisible(page, 'input[autocomplete="family-name"], input[name*="last" i][type="text"], input[name*="lastname" i]'), lastName);
      await fillField(await firstVisible(page, 'input[autocomplete="name"], input[name="name"], input[name*="fullname" i]'), candidate.name);
      await fillField(s.email, accountEmail);
      if (candidate.phone) await fillField(await firstVisible(page, 'input[type="tel"], input[name*="phone" i]'), candidate.phone);
      await fillField(s.password, signupPassword);
      await fillField(s.confirmPassword, signupPassword);
      for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
        const label = ((await box.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? el.parentElement?.textContent ?? "").catch(() => "")) as string).trim();
        if (CONSENT_LABEL.test(label) && !(await box.isChecked().catch(() => true))) await box.check({ force: true }).catch(() => undefined);
      }
      steps.push(`created an account for ${accountEmail} (${signupPasswordSource})`);
      method = "new_account";
      usedPassword = signupPassword;
      const signupUrlBefore = page.url();
      await submitFrom(page, s.password);
      await settle(page);
      const after = await waitForChange(page, signupUrlBefore);
      if (after.challenge) return fail(challengeReason(host), "login");
      if (after.error === "account_exists" && after.password) {
        // An account already exists for this email: sign in instead if we know the password.
        if (savedPassword && (await switchToLogin(page))) {
          steps.push("an account already exists — switched to Sign in");
          signupAttempts = 1;
          continue;
        }
        return fail(`an account already exists for ${accountEmail} on ${host}, but there is no saved password for it — save the candidate's login on the candidate portal`);
      }
      continue;
    }

    // 4) Email-only screen (email first; the password or a code comes next)
    if (s.email) {
      if (emailSubmits >= 2) return fail("the site kept asking for the email address");
      emailSubmits++;
      if (!(await fillField(s.email, accountEmail))) return fail("could not type the email address");
      steps.push(`entered ${accountEmail}`);
      await submitFrom(page, s.email);
      await settle(page);

      const after = await readState(page);
      if (after.error === "no_account" && !after.password && !isBoard && (await switchToSignup(page))) {
        steps.push("no account for that email — switched to Create account");
      }
      continue;
    }

    break;
  }

  return fail(steps.length ? "ran out of steps without getting past the sign-in wall" : "could not find a sign-in control to use", "login");
}
