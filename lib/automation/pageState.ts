import type { Page } from "playwright";
import { findApplyButton } from "@/lib/automation/formHeuristics";

/**
 * Detects a login/account-creation wall blocking the apply flow. Many ATS-hosted apply pages
 * require the candidate to sign in or register before the real application form appears. The
 * flow in signInFlow.ts clears it with the candidate's own saved login (or a new account on an
 * employer site) plus the email code from the candidate's connected Gmail; when it can't, the
 * run hands off to a human.
 */
export async function detectAuthWall(page: Page): Promise<boolean> {
  // Visible only: public job pages (LinkedIn etc.) keep a hidden sign-in modal in the DOM with a
  // password field, which is not a wall — the Apply button on the page is still usable.
  const passwordFieldCount = await page.locator('input[type="password"]:visible').count();
  if (passwordFieldCount > 0) return true;

  const url = page.url().toLowerCase();
  if (/login|signin|sign-in|signup|sign-up|register|registration|account\/new|create-account/.test(url)) return true;

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (
    /sign in to (apply|continue)|log in to (apply|continue)|create (an |your )?account to apply|please (sign in|log in|register)|you (must|need to) (sign in|log in|create an account)|sign[\s-]?in or (sign[\s-]?up|create|register)|log[\s-]?in or (sign[\s-]?up|create|register)|sign[\s-]?up or (sign[\s-]?in|log[\s-]?in)|(sign[\s-]?in|log[\s-]?in|create (an )?account|register)\b.{0,40}\b(before|prior to) applying/i.test(
      bodyText
    )
  ) {
    return true;
  }

  // Email-first walls: no password box yet, just "Continue with email" or a lone email field.
  // A visible Apply button means this is still the job page (the email box is a job-alert widget).
  if ((await findApplyButton(page)) !== null) return false;
  return (await findEmailChooser(page)) !== null || (await hasEmailOnlyGate(page));
}

// "Continue with email", "Sign in with email", "Use email", "Log in using your email" — never the
// Google/Apple/Facebook/LinkedIn/Microsoft buttons, which need that provider's own login.
export const EMAIL_CHOOSER_NAME = /(continue|sign[\s-]?in|log[\s-]?in|sign[\s-]?up|register|use|get started)\s+(with|using|via|by)\s+(an?\s+|your\s+)?e-?mail|^\s*(use\s+)?(an?\s+|your\s+)?e-?mail(\s+address)?\s*$/i;

/** The "continue with email" control, when the page offers sign-in methods and no email field is showing yet. */
export async function findEmailChooser(page: Page) {
  for (const role of ["button", "link"] as const) {
    const control = page.getByRole(role, { name: EMAIL_CHOOSER_NAME }).first();
    if ((await control.count()) > 0 && (await control.isVisible().catch(() => false))) return control;
  }
  return null;
}

/** A page whose whole purpose is one email box + a sign-in / sign-up heading (not a form with other fields). */
export async function hasEmailOnlyGate(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      const rendered = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const zone = 'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="search"], [role="complementary"], [hidden], [aria-hidden="true"]';
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea, select")).filter((el) => {
        const type = (el.type ?? "").toLowerCase();
        return rendered(el) && !el.closest(zone) && !["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "search"].includes(type);
      });
      if (inputs.some((el) => el.type === "file")) return false;
      const emails = inputs.filter((el) => el.type === "email" || /e-?mail|username|login/i.test(`${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${el.autocomplete}`));
      if (emails.length === 0 || inputs.length > 2) return false;
      // Judge the email box by what surrounds IT (a "Sign in" heading right there), never by a "Sign in" link
      // somewhere in the page's navigation — that would make every job page with a job-alert box look like a wall.
      let context = "";
      let node: Element | null = emails[0];
      for (let depth = 0; depth < 5 && node; depth++) {
        node = node.parentElement;
        const text = (node as HTMLElement | null)?.innerText ?? "";
        if (text.length > 25) context = text.slice(0, 500);
        if (text.length > 140) break;
      }
      if (/job alert|newsletter|subscribe|notify me|stay (up to date|informed)|get (new )?jobs|receive/i.test(context)) return false;
      return /sign[\s-]?in|log[\s-]?in|login|sign[\s-]?up|create (an |your )?account|register|continue with email|get started/i.test(context);
    })
    .catch(() => false);
}

/**
 * Marks every visible field that looks like it takes a one-time code (single box, or a row of
 * one-digit boxes) with data-cus-otp and returns how many there are. Requiring a real, visible
 * field is what separates a verification prompt from a page that merely mentions "verify".
 */
export async function markOtpInputs(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      document.querySelectorAll("[data-cus-otp]").forEach((e) => e.removeAttribute("data-cus-otp"));
      const rendered = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const NOT_A_CODE = /zip|postal|promo|coupon|country|phone|mobile|search|salary|year|captcha|e-?mail|password|name/i;
      const CODE_HINT = /otp|one[\s_-]?time|verif(y|ication)[\s_-]?(code|pin|token|number)|security[\s_-]?code|confirm(ation)?[\s_-]?code|passcode|\bpin\b|\bcode\b|auth(entication)?[\s_-]?code|digit/i;

      const all = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter((el) => {
        const type = (el.type ?? "").toLowerCase();
        return rendered(el) && !el.disabled && !el.readOnly && ["text", "tel", "number", "password", ""].includes(type) && !(type === "password" && !/otp|code|pin/i.test(el.name + el.id));
      });

      const marked = new Set<HTMLInputElement>();
      for (const el of all) {
        const descriptor = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${el.labels?.[0]?.textContent ?? ""}`;
        if (el.autocomplete === "one-time-code" || (CODE_HINT.test(descriptor) && !NOT_A_CODE.test(descriptor))) marked.add(el);
      }

      // A row of single-character boxes (the "one box per digit" layout), usually with no name at all.
      const boxes = all.filter((el) => el.maxLength === 1 && (el.inputMode === "numeric" || /^(tel|number)$/.test(el.type) || /\[0-9\]|\\d/.test(el.pattern ?? "")));
      if (boxes.length >= 4) boxes.forEach((el) => marked.add(el));
      const rowBoxes = all.filter((el) => el.maxLength === 1);
      if (rowBoxes.length >= 4 && rowBoxes.length <= 10) rowBoxes.forEach((el) => marked.add(el));

      marked.forEach((el) => el.setAttribute("data-cus-otp", "1"));
      return marked.size;
    })
    .catch(() => 0);
}

/**
 * Detects a one-time-code / email-verification prompt: a visible code field on the page. The flow
 * reads the code from the candidate's own OAuth-connected inbox (otpRetriever.ts) — the account
 * owner retrieving their own code through the agent they authorized at /portal/gmail.
 */
export async function detectOtpWall(page: Page): Promise<boolean> {
  return (await markOtpInputs(page)) > 0;
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
