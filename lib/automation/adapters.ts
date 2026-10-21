import type { Page } from "playwright";
import { classifyHost } from "@/lib/automation/hostPolicy";

/**
 * Platform-specific knowledge for the ATSs that carry most jobs — only the parts a generic engine can't know:
 * the direct application address, platform quirks that sit in front of the form, and the platform's own proof that
 * an application was received. Filling the form itself is generic (labels, comboboxes, saved answers), so an
 * adapter stays small and a platform redesign breaks one function, not the whole flow.
 *
 * What was verified against live pages: Greenhouse (job-boards.greenhouse.io) and Lever (jobs.lever.co) up to the
 * final Submit, Workday up to its sign-in screen. Nothing here ever clicks a final Submit; that is the engine's job.
 */

export interface AtsAdapter {
  id: "GREENHOUSE" | "LEVER" | "WORKDAY";
  /** The direct application address for a posting address, when it differs; null to keep the posting address. */
  applicationUrl?(url: string): string | null;
  /** Clears a platform-specific step in front of the form. Returns what it did, or null when there was nothing to do. */
  advance?(page: Page): Promise<string | null>;
  /** Positive, platform-specific proof the application was received — a short description, or null if not shown. */
  confirmed?(page: Page): Promise<string | null>;
}

const visibleHeading = (page: Page, pattern: RegExp) =>
  page
    .evaluate((source) => {
      const re = new RegExp(source, "i");
      return Array.from(document.querySelectorAll("h1, h2, h3, [role=heading]")).some((h) => (h as HTMLElement).getClientRects().length > 0 && re.test((h as HTMLElement).innerText || ""));
    }, pattern.source)
    .catch(() => false);

const greenhouse: AtsAdapter = {
  id: "GREENHOUSE",
  // Postings and their forms share one page on boards.greenhouse.io / job-boards.greenhouse.io — nothing to rewrite.
  async confirmed(page) {
    if (/\/confirmation\b/i.test(page.url())) return "Greenhouse confirmation page";
    if (await visibleHeading(page, /thank you for applying|application (has been )?(submitted|received)|thanks for applying/)) return "Greenhouse \"Thank you for applying\" page";
    return null;
  },
};

const lever: AtsAdapter = {
  id: "LEVER",
  // A Lever posting's form lives at <posting>/apply; going there directly skips the posting page and its overlays.
  applicationUrl(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)lever\.co$/i.test(u.hostname)) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      // /<company>/<posting-id>  ->  /<company>/<posting-id>/apply
      if (parts.length === 2 && /^[0-9a-f-]{20,}$/i.test(parts[1])) {
        u.pathname = `/${parts.join("/")}/apply`;
        return u.toString();
      }
    } catch {
      /* not a URL */
    }
    return null;
  },
  async confirmed(page) {
    if (/\/thanks\b/i.test(page.url())) return "Lever confirmation page";
    if (await visibleHeading(page, /application submitted|thanks for applying|thank you for (applying|your application)/)) return "Lever \"Application submitted\" page";
    return null;
  },
};

const workday: AtsAdapter = {
  id: "WORKDAY",
  // Clicking Apply on a Workday posting opens "Start Your Application" (Autofill with Resume / Apply Manually / Use My
  // Last Application) before anything else. Both real choices lead to the same Create Account / Sign In screen; the
  // manual one makes no assumption about what happens after it, so that is the one taken.
  async advance(page) {
    const manual = page.locator('[data-automation-id="applyManually"]').first();
    if ((await manual.count()) === 0 || !(await manual.isVisible().catch(() => false))) return null;
    await manual.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    return 'chose "Apply Manually" in the Start Your Application dialog';
  },
  async confirmed(page) {
    if (await visibleHeading(page, /application submitted|thank you for applying|you('ve| have) (successfully )?(applied|submitted)|your application has been submitted/)) return "Workday confirmation page";
    return null;
  },
};

const ADAPTERS: AtsAdapter[] = [greenhouse, lever, workday];

/** The adapter for the ATS a URL belongs to, or null (the generic flow handles everything else). */
export function adapterFor(url: string): AtsAdapter | null {
  const info = classifyHost(url);
  if (info.hostClass !== "ATS" || !info.ats) return null;
  return ADAPTERS.find((a) => a.id === info.ats) ?? null;
}
