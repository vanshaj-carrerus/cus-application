import type { Page } from "playwright";
import type { ICandidate } from "@/lib/models/Candidate";

type AtsType = "GREENHOUSE" | "LEVER" | "WORKDAY" | "TALEO" | "GENERIC";

function detectAts(url: string): AtsType {
  const host = url.toLowerCase();
  if (host.includes("greenhouse.io")) return "GREENHOUSE";
  if (host.includes("lever.co")) return "LEVER";
  if (host.includes("myworkdayjobs.com") || host.includes("workday.com")) return "WORKDAY";
  if (host.includes("taleo.net")) return "TALEO";
  return "GENERIC";
}

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
    resumeFile: ['input[type="file"][name*="resume" i]', 'input[type="file"][name*="cv" i]', 'input[type="file"]'],
  },
};

async function fillFirstMatch(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
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

export async function fillApplicationForm(page: Page, candidate: ICandidate, resumeFilePath: string): Promise<FormFillResult> {
  const ats = detectAts(page.url());
  const fields = SELECTORS[ats];
  const filled: Record<string, boolean> = {};

  const [firstName, ...rest] = candidate.name.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  if (fields.fullName) filled.fullName = await fillFirstMatch(page, fields.fullName, candidate.name);
  if (fields.firstName) filled.firstName = await fillFirstMatch(page, fields.firstName, firstName);
  if (fields.lastName) filled.lastName = await fillFirstMatch(page, fields.lastName, lastName);
  if (fields.email && candidate.email) filled.email = await fillFirstMatch(page, fields.email, candidate.email);
  if (fields.phone && candidate.phone) filled.phone = await fillFirstMatch(page, fields.phone, candidate.phone);
  // linkedin/portfolio selectors are detected but intentionally left unfilled —
  // ICandidate has no linkedin/portfolio fields, and writing a blank value into a
  // required-format field is worse than leaving it for the candidate to fill in.

  let resumeAttached = false;
  for (const selector of fields.resumeFile ?? []) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.setInputFiles(resumeFilePath).catch(() => undefined);
      resumeAttached = true;
      break;
    }
  }

  return { ats, filled, resumeAttached };
}

export async function findSubmitButton(page: Page) {
  const candidates = [
    'button:has-text("Submit Application")',
    'button:has-text("Submit application")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
  }
  return null;
}
