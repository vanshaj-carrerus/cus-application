import type { Page, Frame, Locator } from "playwright";
import type { ICandidate } from "@/lib/models/Candidate";

// Most helpers here work against either a page's main frame or a child iframe —
// many ATS forms (Greenhouse embeds, some Workday tenants) load the actual form
// inside an <iframe>, not the top-level document.
type Interactable = Page | Frame;

type AtsType = "GREENHOUSE" | "LEVER" | "WORKDAY" | "TALEO" | "GENERIC";

function detectAts(url: string): AtsType {
  const host = url.toLowerCase();
  if (host.includes("greenhouse.io")) return "GREENHOUSE";
  if (host.includes("lever.co")) return "LEVER";
  if (host.includes("myworkdayjobs.com") || host.includes("workday.com")) return "WORKDAY";
  if (host.includes("taleo.net")) return "TALEO";
  return "GENERIC";
};

// Ordered candidate selectors per field, per known ATS. First visible match wins.
// Falls through to GENERIC's label/placeholder/attribute heuristics for anything
// not covered by a platform-specific selector.
const SELECTORS: Record<AtsType, Record<string, string[]>> = {
  GREENHOUSE: {
    firstName: ["#first_name"],
    lastName: ["#last_name"],
    email: ["#email"],
    phone: ["#phone"],
    linkedin: ['input[name*="linkedin" i]'],
    portfolio: ['input[name*="website" i]', 'input[name*="portfolio" i]'],
    resumeFile: ['input[type="file"][name*="resume" i]', 'input[type="file"]'],
  },
  LEVER: {
    fullName: ['input[name="name"]'],
    email: ['input[name="email"]'],
    phone: ['input[name="phone"]'],
    linkedin: ['input[name="urls[LinkedIn]"]'],
    portfolio: ['input[name="urls[Portfolio]"]', 'input[name="urls[Website]"]'],
    resumeFile: ['input[name="resume"]', 'input[type="file"]'],
  },
  WORKDAY: {
    firstName: ['input[data-automation-id*="firstName" i]'],
    lastName: ['input[data-automation-id*="lastName" i]'],
    email: ['input[data-automation-id*="email" i]'],
    phone: ['input[data-automation-id*="phone" i]'],
    resumeFile: ['input[type="file"][data-automation-id*="resume" i]', 'input[type="file"]'],
  },
  TALEO: {
    firstName: ['input[id*="firstName" i]'],
    lastName: ['input[id*="lastName" i]'],
    email: ['input[id*="email" i]'],
    phone: ['input[id*="phone" i]'],
    resumeFile: ['input[type="file"]'],
  },
  GENERIC: {
    fullName: ['input[autocomplete="name"]', 'input[name*="full_name" i]', 'input[name*="fullname" i]'],
    firstName: ['input[autocomplete="given-name"]', 'input[name*="first_name" i]', 'input[name*="firstname" i]'],
    lastName: ['input[autocomplete="family-name"]', 'input[name*="last_name" i]', 'input[name*="lastname" i]'],
    email: ['input[type="email"]', 'input[name*="email" i]'],
    phone: ['input[type="tel"]', 'input[name*="phone" i]'],
    linkedin: ['input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]'],
    portfolio: ['input[name*="portfolio" i]', 'input[name*="website" i]'],
    resumeFile: [
      'input[type="file"][name*="resume" i]',
      'input[type="file"][name*="cv" i]',
      'input[type="file"][id*="resume" i]',
      'input[type="file"][aria-label*="resume" i]',
      'input[type="file"]',
    ],
  },
};

async function fillFirstMatch(ctx: Interactable, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = ctx.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.fill(value).catch(() => undefined);
      return true;
    }
  }
  return false;
}

export interface FormFillResult {
  ats: AtsType;
  filled: Record<string, boolean>;
  resumeAttached: boolean;
}

/**
 * True if this frame/page currently shows a real application form, not a job-description
 * page that merely has inputs somewhere in its DOM (site search, newsletter box, cookie
 * banner, a hidden "apply" modal). Only fields that are actually rendered count, fields in
 * the header/nav/footer and search/newsletter-style fields are ignored, and fields are
 * grouped per <form> so scattered unrelated inputs can't add up to a "form". A visible
 * resume upload is strong evidence on its own; otherwise a group needs 3+ fields, or 2+
 * with a name/email/phone-style field. Login/signup forms (password field) don't count here —
 * those are handled as auth walls.
 */
export async function hasVisibleFormFields(ctx: Interactable): Promise<boolean> {
  return ctx
    .evaluate(() => {
      // tsx/esbuild wraps named inner functions in a __name() helper that doesn't exist in the browser.
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;

      const isRendered = (el: Element) => {
        if (el.getClientRects().length === 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      };
      const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "search"]);
      const NOISE = /search|keyword|newsletter|subscribe|coupon|captcha|cookie|consent|filter/i;
      const IDENTITY = /name|e-?mail|phone|mobile|resume|cv|linkedin/i;

      const groups = new Map<Element | null, { fields: number; identity: boolean; file: boolean; password: boolean }>();
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea, select"))) {
        if (el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="search"], [aria-hidden="true"], [hidden]')) continue;
        const form = el.closest("form");
        const group = groups.get(form) ?? { fields: 0, identity: false, file: false, password: false };
        groups.set(form, group);

        const type = (el.type ?? "").toLowerCase();
        if (type === "password") {
          if (isRendered(el)) group.password = true;
          continue;
        }
        if (type === "file") {
          // File inputs are routinely visually hidden behind a custom button, so judge the
          // surrounding form (or the page) instead of the input itself.
          if (!form || isRendered(form)) group.file = true;
          continue;
        }
        if (SKIP_TYPES.has(type) || !isRendered(el)) continue;

        const descriptor = [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].join(" ");
        if (NOISE.test(descriptor)) continue;
        group.fields++;
        if (type === "email" || type === "tel" || IDENTITY.test(descriptor)) group.identity = true;
      }

      for (const group of groups.values()) {
        if (group.password && !group.file) continue;
        if (group.file || group.fields >= 3 || (group.fields >= 2 && group.identity)) return true;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Polls until a real application form is rendered somewhere on the page (main frame or an
 * iframe), returning false on timeout. Forms are frequently injected by JS after
 * domcontentloaded, so classifying the page the instant it loads gives false negatives.
 */
export async function waitForApplicationForm(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await hasVisibleFormFields(await findFormContext(page))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return false;
}

/**
 * Picks the frame most likely to hold the actual application form: the main frame
 * if it has form fields, otherwise the child iframe with the most of them (some ATS
 * embeds — Greenhouse job boards, certain Workday tenants — load the form in an iframe).
 */
export async function findFormContext(page: Page): Promise<Interactable> {
  if (await hasVisibleFormFields(page)) return page;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (await hasVisibleFormFields(frame)) return frame;
  }
  return page;
}

export async function fillApplicationForm(ctx: Interactable, candidate: ICandidate, resumeFilePath: string): Promise<FormFillResult> {
  const ats = detectAts(ctx.url());
  const fields = SELECTORS[ats];
  const filled: Record<string, boolean> = {};

  const [firstName, ...rest] = candidate.name.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  if (fields.fullName) filled.fullName = await fillFirstMatch(ctx, fields.fullName, candidate.name);
  if (fields.firstName) filled.firstName = await fillFirstMatch(ctx, fields.firstName, firstName);
  if (fields.lastName) filled.lastName = await fillFirstMatch(ctx, fields.lastName, lastName);
  if (fields.email && candidate.email) filled.email = await fillFirstMatch(ctx, fields.email, candidate.email);
  if (fields.phone && candidate.phone) filled.phone = await fillFirstMatch(ctx, fields.phone, candidate.phone);
  // linkedin/portfolio selectors are detected but intentionally left unfilled —
  // ICandidate has no linkedin/portfolio fields, and writing a blank value into a
  // required-format field is worse than leaving it for the candidate to fill in.

  let resumeAttached = false;
  for (const selector of fields.resumeFile ?? []) {
    const locator = ctx.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.setInputFiles(resumeFilePath).catch(() => undefined);
      resumeAttached = true;
      break;
    }
  }

  return { ats, filled, resumeAttached };
}

async function firstVisibleMatch(ctx: Interactable, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = ctx.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
  }
  return null;
}

// A bare :has-text("Apply") matches "Applications", "Apply filters", "Applicant login"... so the
// generic fallback only accepts controls whose whole accessible name is an apply call-to-action.
const APPLY_CONTROL_NAME =
  /^s*(easys+|quicks+)?apply(s+(now|today|here|online|fors+(thiss+)?(job|position|role)|tos+(thiss+)?(job|position|role)|ons+(thes+)?companys+(site|website)))?s*[→>»›]*s*$/i;

async function firstVisibleRole(ctx: Interactable, name: RegExp): Promise<Locator | null> {
  for (const role of ["button", "link"] as const) {
    const locator = ctx.getByRole(role, { name }).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator;
  }
  return null;
}

/**
 * The initial "open the application form" control on a job description/listing
 * page — distinct from the real submit button. Many career sites' applicationUrl
 * points at a JD page, not the form itself; this is what gets you from one to the other.
 */
export async function findApplyButton(ctx: Interactable): Promise<Locator | null> {
  const exact = await firstVisibleMatch(ctx, [
    'a:has-text("Apply Now")',
    'button:has-text("Apply Now")',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
    'a:has-text("Apply to this position")',
    'button:has-text("Apply to this position")',
  ]);
  return exact ?? (await firstVisibleRole(ctx, APPLY_CONTROL_NAME));
}

/** The terminal control that actually submits the application — never matches "Apply" text. */
export async function findSubmitButton(ctx: Interactable): Promise<Locator | null> {
  return firstVisibleMatch(ctx, [
    'button:has-text("Submit Application")',
    'button:has-text("Submit application")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
  ]);
}

/** Advances to the next page of a multi-step application wizard. */
export async function findNextButton(ctx: Interactable): Promise<Locator | null> {
  return firstVisibleMatch(ctx, [
    'button:has-text("Save and Continue")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'a:has-text("Next")',
  ]);
}

/**
 * Finds a clickable control (link, button, role=button, submit input) whose visible
 * text roughly matches `text` — used to click through on a control an AI vision call
 * identified by its label when the fixed DOM selectors in findApplyButton() didn't
 * match (icon-only buttons, unusual copy like "I'm Interested", custom components).
 */
export async function findClickableByText(ctx: Interactable, text: string): Promise<Locator | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const exact = ctx.getByRole("button", { name: trimmed, exact: false }).or(ctx.getByRole("link", { name: trimmed, exact: false })).first();
  if ((await exact.count()) > 0 && (await exact.isVisible().catch(() => false))) return exact;

  const escaped = trimmed.replace(/["\\]/g, "\\$&");
  const candidate = ctx
    .locator(`a:has-text("${escaped}"), button:has-text("${escaped}"), [role="button"]:has-text("${escaped}"), input[type="submit"][value*="${escaped}" i]`)
    .first();
  if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) return candidate;

  return null;
}

export type PageIntent = "JOB_DETAIL" | "APPLICATION_FORM" | "UNKNOWN";

// Zero-cost URL-based signal, checked before/alongside the DOM field count — a
// deterministic router so the agent doesn't have to guess where it is from field
// counts alone. Job description pages ("/careers/senior-engineer") and application
// forms ("/apply", "/candidate-portal") tend to have distinctly shaped URLs.
const JOB_DETAIL_URL_PATTERN = /\/(job|jobs|career|careers|posting|postings|opening|openings|position|vacanc(y|ies))(?!.*\/(apply|application))/i;
const APPLICATION_URL_PATTERN = /\/(apply|application|candidate)/i;

/**
 * Classifies the current page/frame as a job-description page (needs an Apply
 * click), an actual application form (needs filling), or unknown — combining the
 * free URL/DOM signals so this never has to reach for AI just to figure out where
 * it is. Logged at every loop iteration in applyEngine.ts for visibility.
 */
export async function classifyPageIntent(ctx: Interactable): Promise<PageIntent> {
  if (await hasVisibleFormFields(ctx)) return "APPLICATION_FORM";

  // The form may live in an iframe (Greenhouse embeds, some Workday tenants) while the
  // top-level document is just the job description.
  if ("frames" in ctx) {
    for (const frame of ctx.frames()) {
      if (frame !== ctx.mainFrame() && (await hasVisibleFormFields(frame))) return "APPLICATION_FORM";
    }
  }

  // No form rendered. An Apply control means we're on the job description; the URL is only
  // a tie-breaker. An /apply-style URL with no fields yet is *not* reported as a form — it is
  // usually still loading, and the caller waits for it (waitForApplicationForm) rather than
  // trying to fill a page with nothing on it.
  if ((await findApplyButton(ctx)) !== null) return "JOB_DETAIL";

  const url = ctx.url().toLowerCase();
  if (JOB_DETAIL_URL_PATTERN.test(url) && !APPLICATION_URL_PATTERN.test(url)) return "JOB_DETAIL";

  return "UNKNOWN";
}
