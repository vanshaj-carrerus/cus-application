import type { Page } from "playwright";

/**
 * Clears the things that sit on top of a page and hide the real controls: cookie/consent banners and
 * pop-ups (newsletter, "get the app", and the "sign in to see more" pop-up job boards like LinkedIn put
 * over a public job page). Without this the Apply button is covered, so the page looks like a dead end
 * or a login wall when it isn't.
 *
 * Sign-in pop-ups are only closed when asked (`signInPopups`) — right after the automation itself
 * clicked Apply, a sign-in dialog is the wall to get through, not something to dismiss.
 */

export interface DismissOptions {
  signInPopups: boolean;
}

interface Dismissal {
  kind: "cookie" | "signin" | "popup";
  label: string;
}

const MAX_ROUNDS = 4;

export async function dismissOverlays(page: Page, options: DismissOptions): Promise<string[]> {
  const done: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const target = await page
      .evaluate((opts) => {
        document.querySelectorAll("[data-cus-dismiss]").forEach((e) => e.removeAttribute("data-cus-dismiss"));

        const rendered = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
        };
        const nameOf = (el: Element) => ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim() || el.getAttribute("aria-label") || el.getAttribute("title") || "";

        const COOKIE_WORDS = /cookie|consent|gdpr|ccpa|onetrust|cmp|didomi|truste|osano|usercentrics|privacy[-_ ]?(banner|notice|settings)/i;
        const ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree( (and|&) (continue|close|proceed))?|i agree|i accept|got it|ok(ay)?|understood|continue|accept (and|&) close|yes,? i agree|that'?s ok)$/i;
        const REJECT = /^(reject( all)?( cookies)?|decline( all)?|deny( all)?|necessary( cookies)?( only)?|only necessary|essential( cookies)?( only)?|use necessary cookies only|refuse( all)?|no,? thanks?)$/i;
        const CLOSE = /^(close( menu| dialog| window| popup| pop-up)?|dismiss|×|✕|✖|x|no,? thanks?( ,? ?i'?ll (do it )?later)?|not now|maybe later|skip( for now| this| it)?|remind me later|later|i'?ll do it later|cancel|got it|continue (as (a )?guest|without (signing in|an account|registering)))$/i;

        // An element is "overlay-ish" when it is a dialog, or fixed/sticky to the viewport.
        const overlayRootOf = (el: Element): Element | null => {
          for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
            const role = node.getAttribute("role");
            const style = getComputedStyle(node);
            if (role === "dialog" || role === "alertdialog" || node.getAttribute("aria-modal") === "true") return node;
            if ((style.position === "fixed" || style.position === "sticky") && node.getBoundingClientRect().width > 120 && node.getBoundingClientRect().height > 40) return node;
            if (/modal|popup|pop-up|overlay|lightbox|interstitial|drawer|banner|toast/i.test(`${node.id} ${node.className?.toString?.() ?? ""}`)) return node;
          }
          return null;
        };

        const candidates = Array.from(document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")).filter(rendered);
        type Pick = { el: Element; kind: "cookie" | "signin" | "popup"; rank: number; label: string };
        const picks: Pick[] = [];
        for (const el of candidates) {
          const label = nameOf(el);
          const isReject = REJECT.test(label);
          const isAccept = ACCEPT.test(label);
          const isClose = CLOSE.test(label) || /^(close|dismiss)\b/i.test(el.getAttribute("aria-label") ?? "") || /dismiss|modal-close|close-button|btn-close/i.test(`${el.className?.toString?.() ?? ""} ${el.getAttribute("data-modal-dismiss") ?? ""} ${el.getAttribute("data-tracking-control-name") ?? ""}`);
          if (!isReject && !isAccept && !isClose) continue;

          const root = overlayRootOf(el);
          if (!root) continue;
          const rootText = (root as HTMLElement).innerText?.slice(0, 1500) ?? "";
          const rootMeta = `${root.id} ${root.className?.toString?.() ?? ""}`;
          const isCookie = COOKIE_WORDS.test(rootMeta) || /\bcookies?\b|we use (cookies|tracking)|consent/i.test(rootText);
          const isSignin = !isCookie && /sign in|log in|join now|create (an )?account|join linkedin|continue with (google|email)/i.test(rootText);

          if (isCookie) {
            // Cookie banners: prefer the least-sharing choice, fall back to accepting so the banner stops covering the page.
            const rank = isReject ? 1 : isClose && !isAccept ? 2 : 3;
            picks.push({ el, kind: "cookie", rank, label });
          } else if (isSignin) {
            if (opts.signInPopups && (isClose || /^(no,? thanks?|not now|maybe later|skip)$/i.test(label))) picks.push({ el, kind: "signin", rank: 4, label: label || "close" });
          } else if (isClose && !isAccept) {
            picks.push({ el, kind: "popup", rank: 5, label: label || "close" });
          }
        }
        if (picks.length === 0) return null;
        picks.sort((a, b) => a.rank - b.rank);
        picks[0].el.setAttribute("data-cus-dismiss", "1");
        return { kind: picks[0].kind, label: picks[0].label };
      }, options)
      .catch(() => null);

    if (!target) break;
    const control = page.locator('[data-cus-dismiss="1"]').first();
    const before = await page.locator("body").innerText().then((t) => t.length).catch(() => 0);
    await control.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    done.push(`${target.kind}: "${(target as Dismissal).label || "close"}"`);
    const after = await page.locator("body").innerText().then((t) => t.length).catch(() => 0);
    // Nothing changed (the control did nothing): stop rather than click it again.
    if (before === after && round >= 1) break;
  }
  await page.evaluate(() => document.querySelectorAll("[data-cus-dismiss]").forEach((e) => e.removeAttribute("data-cus-dismiss"))).catch(() => undefined);
  return done;
}
