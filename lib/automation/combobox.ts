import type { Locator, Page } from "playwright";

/**
 * Operating custom dropdowns ("comboboxes") — the React-Select / autocomplete widgets that Greenhouse, Lever,
 * Workday, Ashby and most modern ATSs use instead of a native <select>. A native select can be set in one call;
 * these have to be opened, (often) typed into, and an option clicked — then checked, because a click that
 * "worked" but selected nothing would leave a required field empty and the form rejected.
 *
 * Three behaviours are handled:
 *   - short list that opens on click          (Yes/No, "How did you hear")  -> read the options, pick one
 *   - long list                                (244 countries)               -> type to filter, pick the match
 *   - remote autocomplete                      (city / location search)      -> type, wait for suggestions, pick the match
 */

export const MAX_LISTED_OPTIONS = 80;
const PLACEHOLDER = /^(select|choose|please select|--|—|search|type to)/i;

/** Visible option-like texts of an open dropdown (role=option, or list items of an open listbox). */
async function visibleOptionTexts(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const rendered = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const out: string[] = [];
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll('[role="option"], [role="listbox"] [role="menuitem"], [role="listbox"] li'))) {
        if (!rendered(el)) continue;
        const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          out.push(text);
        }
      }
      return out;
    })
    .catch(() => []);
}

/**
 * The options a combobox offers, or null when it has none to list up front (empty until typed into — a remote
 * autocomplete) or too many to be worth listing (type to filter instead).
 */
export async function readComboboxOptions(field: Locator): Promise<string[] | null> {
  const page = field.page();
  try {
    await field.scrollIntoViewIfNeeded({ timeout: 3_000 });
    await field.click({ timeout: 3_000 });
    await page.waitForTimeout(500);
    const options = (await visibleOptionTexts(page)).filter((o) => !PLACEHOLDER.test(o));
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
    return options.length > 0 && options.length <= MAX_LISTED_OPTIONS ? options : null;
  } catch {
    return null;
  }
}

/* ── matching a wanted value against the options a widget shows ───────── */

const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana",
  ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska",
  nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island",
  sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};
const COUNTRY_ALIASES: Record<string, string> = { us: "united states", usa: "united states", "u s": "united states", "u s a": "united states", uk: "united kingdom", "great britain": "united kingdom", uae: "united arab emirates" };

function canon(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*\+\d[\d\s-]*$/, "") // phone-code suffix: "United States +1"
    .replace(/[(),.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-level tokens with state abbreviations and country aliases expanded ("tx" -> "texas", "us" -> "united states"). */
function tokens(text: string): string[] {
  const c = canon(text);
  const aliased = COUNTRY_ALIASES[c];
  const base = (aliased ?? c).split(" ").filter(Boolean);
  const out: string[] = [];
  for (const t of base) {
    const state = US_STATES[t];
    if (state && base.length > 1) out.push(...state.split(" "));
    else if (COUNTRY_ALIASES[t] && base.length > 1) out.push(...COUNTRY_ALIASES[t].split(" "));
    else out.push(t);
  }
  return out;
}

/** 0-100: how well an option matches the wanted text. Below 55 is treated as "not it". */
export function matchScore(wanted: string, option: string): number {
  const w = canon(COUNTRY_ALIASES[canon(wanted)] ?? wanted);
  const o = canon(option);
  if (!w || !o) return 0;
  if (w === o) return 100;
  if (o.startsWith(`${w} `) || o.startsWith(`${w},`)) return 92;
  if (w.startsWith(`${o} `)) return 88;
  const wt = tokens(wanted);
  const ot = new Set(tokens(option));
  if (wt.length === 0) return 0;
  const shared = wt.filter((t) => ot.has(t)).length;
  if (shared === 0) return 0;
  // The first word is the main one (the city, the country): without it the rest is coincidence.
  const firstHit = ot.has(wt[0]);
  const score = (shared / wt.length) * 80 + (firstHit ? 15 : 0) - Math.min(8, Math.max(0, ot.size - wt.length) * 2);
  return Math.round(score);
}

export function bestOption(wanted: string, options: string[]): { option: string; score: number } | null {
  let best: { option: string; score: number } | null = null;
  for (const option of options) {
    const score = matchScore(wanted, option);
    if (score > (best?.score ?? 0)) best = { option, score };
  }
  return best && best.score >= 55 ? best : null;
}

/** Marks the on-page element for `optionText` (role=option, or a suggestion popup entry near the field) and returns whether found. */
async function markSuggestion(page: Page, field: Locator, optionText: string): Promise<boolean> {
  const box = await field.boundingBox().catch(() => null);
  return page.evaluate(
    ({ optionText, box }) => {
      document.querySelectorAll("[data-cus-pick]").forEach((e) => e.removeAttribute("data-cus-pick"));
      const rendered = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const textOf = (el: Element) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      let pool = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, [role="menuitem"]')).filter(rendered);
      if (pool.length === 0 && box) {
        // Autocompletes that don't use ARIA roles (Lever's location): leaf entries in a popup just under the field.
        pool = Array.from(document.querySelectorAll("li, div, span, a, button")).filter((el) => {
          if (!rendered(el) || el.children.length > 0 && el.querySelectorAll("*").length > 3) return false;
          const r = el.getBoundingClientRect();
          return r.top >= box.y + box.height - 8 && r.top <= box.y + box.height + 420 && r.left < box.x + box.width + 60 && r.right > box.x - 60;
        });
      }
      const hit = pool.find((el) => textOf(el) === optionText) ?? pool.find((el) => textOf(el).startsWith(optionText));
      if (!hit) return false;
      hit.setAttribute("data-cus-pick", "1");
      return true;
    },
    { optionText, box }
  );
}

/** Option-like texts shown for the field right now, including non-ARIA suggestion popups under it. */
async function currentSuggestions(page: Page, field: Locator, typed: string): Promise<string[]> {
  const aria = await visibleOptionTexts(page);
  if (aria.length > 0) return aria.filter((o) => !PLACEHOLDER.test(o));
  const box = await field.boundingBox().catch(() => null);
  if (!box) return [];
  const firstWord = canon(typed).split(" ")[0] ?? "";
  return page
    .evaluate(
      ({ box, firstWord }) => {
        const rendered = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
        const out = new Set<string>();
        for (const el of Array.from(document.querySelectorAll("li, div, span, a, button"))) {
          if (!rendered(el) || (el.children.length > 0 && el.querySelectorAll("*").length > 3)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.top >= box.y + box.height - 8 && r.top <= box.y + box.height + 420 && r.left < box.x + box.width + 60 && r.right > box.x - 60)) continue;
          const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
          // Only entries that are about what was typed: everything else under the field is the rest of the form.
          if (text && text.length < 100 && text.toLowerCase().includes(firstWord)) out.add(text);
        }
        return [...out];
      },
      { box, firstWord }
    )
    .catch(() => []);
}

export interface ChooseResult {
  ok: boolean;
  chosen?: string;
  reason?: string;
}

/**
 * Selects the option best matching `wanted`, then verifies the widget actually shows a choice. Types the value to
 * filter/search first (long lists, remote autocompletes). Never picks a poor match: below the score threshold it
 * reports failure so the field is left for a person rather than set to something else.
 */
export async function chooseComboboxOption(field: Locator, wanted: string): Promise<ChooseResult> {
  const page = field.page();
  const typed = wanted.includes(",") ? wanted.split(",")[0].trim() : wanted.trim();
  try {
    await field.scrollIntoViewIfNeeded({ timeout: 3_000 });
    const before = await wrapperText(field);
    await field.click({ timeout: 4_000 });
    await page.waitForTimeout(250);
    if (typed) await field.pressSequentially(typed.slice(0, 40), { delay: 30 });

    // Wait for the suggestions to settle (remote autocompletes answer after a moment).
    let options: string[] = [];
    let stableFor = 0;
    for (let i = 0; i < 20 && stableFor < 2; i++) {
      await page.waitForTimeout(250);
      const now = await currentSuggestions(page, field, typed);
      stableFor = now.length > 0 && now.join("|") === options.join("|") ? stableFor + 1 : 0;
      options = now;
    }
    if (options.length === 0) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return { ok: false, reason: `no options appeared for "${typed}"` };
    }

    const best = bestOption(wanted, options);
    if (!best) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return { ok: false, reason: `none of the ${options.length} options matches "${wanted}" (saw: ${options.slice(0, 4).join("; ")})` };
    }
    if (!(await markSuggestion(page, field, best.option))) return { ok: false, reason: "could not find the option to click" };
    await page.locator("[data-cus-pick]").first().click({ timeout: 4_000 });
    await page.waitForTimeout(450);

    // Verify. Best evidence: the widget's own "selected value" element now shows the choice (this also covers a
    // field that already held the right value, e.g. a phone-country picker the phone number had pre-set).
    const parts = [...new Set([...tokens(best.option), ...best.option.toLowerCase().split(/\s+/)].filter((t) => t.length >= 2))];
    const echoes = (text: string) => parts.some((t) => text.toLowerCase().includes(t));
    const selected = await selectedValueText(field);
    if (selected !== null) {
      return echoes(selected) ? { ok: true, chosen: best.option } : { ok: false, chosen: best.option, reason: `clicked "${best.option}" but the field shows "${selected.slice(0, 40)}"` };
    }
    // No identifiable value element (a plain autocomplete input): the text around it must have changed AND echo the choice.
    const after = await wrapperText(field);
    const value = await field.inputValue().catch(() => "");
    const changed = after !== before || (value.trim() !== "" && value.trim().toLowerCase() !== typed.toLowerCase());
    if (!echoes(`${after} ${value}`) || !changed) return { ok: false, chosen: best.option, reason: `clicked "${best.option}" but the field does not show it` };
    return { ok: true, chosen: best.option };
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/** The text of the widget's own "selected value" element (React-Select's single value etc.), or null if it has none. */
async function selectedValueText(field: Locator): Promise<string | null> {
  return field
    .evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      for (let i = 0; i < 5 && node?.parentElement; i++) {
        node = node.parentElement;
        const holder = node.querySelector('[class*="singleValue" i], [class*="single-value" i], [class*="selected-value" i], [class*="selectedValue" i]');
        if (holder) return ((holder as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      }
      return null;
    })
    .catch(() => null);
}

/** Text of the widget around the field (its displayed value lives in a sibling, not in the input). */
async function wrapperText(field: Locator): Promise<string> {
  return field
    .evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      for (let i = 0; i < 4 && node?.parentElement; i++) node = node.parentElement;
      return (node?.innerText ?? "").replace(/\s+/g, " ").trim();
    })
    .catch(() => "");
}

/**
 * For a plain text field that shows a suggestion popup as you type (a location or city search that is not marked up
 * as a combobox, e.g. Lever's): after the text is typed, click the suggestion that best matches it. Returns the
 * suggestion chosen, or null when no popup appeared (an ordinary text field) or nothing matched well enough.
 */
export async function pickAutocompleteSuggestion(field: Locator, typed: string, waitMs = 2_500): Promise<string | null> {
  const page = field.page();
  const deadline = Date.now() + waitMs;
  let options: string[] = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    options = await currentSuggestions(page, field, typed);
    if (options.length > 0) break;
  }
  if (options.length === 0) return null;
  const best = bestOption(typed, options);
  if (!best || !(await markSuggestion(page, field, best.option))) return null;
  await page.locator("[data-cus-pick]").first().click({ timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  return best.option;
}
