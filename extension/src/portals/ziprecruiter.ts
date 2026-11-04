import type { AssistCandidate } from "../../../lib/automation/formEngine";
import { isZipRecruiterHost, MAX_JOBS_PER_SEARCH, type ApplyOutcome, type JobCard } from "../linkedin-shared";
import { clean, clearChallenge, deepAll, press, say, sleep, visible, waitFor, type Send } from "../linkedin-apply";
import { driveTask, waitForPerson } from "../external-apply";

/**
 * ZIPRECRUITER. Everything here is about ZipRecruiter's own pages only (see PLAYBOOKS.md for the steps and what it does and
 * does not have). The run works from the candidate's own signed-in browser:
 *
 *   search page -> read the job cards
 *   job page    -> "1-Click Apply" / "Quick Apply" (ZipRecruiter's own: sent from the page or a short form on it), or
 *                  "Apply" (the company's own site, opened in another tab)
 *   company site -> filled and submitted by the shared form driver (external-apply.ts)
 *
 * Signing in and verification stay with the candidate (the run waits).
 */

type Result = { outcome: ApplyOutcome | "EXTERNAL"; reason?: string };
type Task = { kind: "search" | "job" | "external"; seq: number; job?: JobCard; candidate?: AssistCandidate; delayMs?: number; own?: boolean };

/* ── signing in ───────────────────────────────────────────────────────── */

function needsSignIn(): boolean {
  if (/\/(authn|login|signin|sign-in|candidate\/login)/i.test(location.pathname)) return true;
  return deepAll<HTMLInputElement>('input[type="password"]').some(visible);
}

async function ensureSignedIn(send: Send): Promise<boolean> {
  if (!needsSignIn()) return true;
  const ok = await waitForPerson(send, "ZipRecruiter needs the candidate to sign in. Sign in in this window and the run continues.", () => !needsSignIn());
  await sleep(1_500);
  return ok;
}

/* ── search results ───────────────────────────────────────────────────── */

const CARD = 'article[id^="job-card"], [data-testid="job-card"], article.job_result, .job_result_two_pane, li[class*="job" i] article';

const LINKS = 'a[href*="/c/"][href*="/Job/"], a[href*="lvk="], a[href*="lk="]';
/** The number in "504 Full stack web developer jobs in New York US", or 0 for the "No jobs found" page, or null when the page says neither. */
const resultCount = (): number | null => {
  const text = document.body?.innerText ?? "";
  if (/no jobs found/i.test(text)) return 0;
  const m = text.match(/([\d,]+)\s+[^\n]{0,80}?\bjobs?\s+in\b/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
/**
 * The site's own top bar (logo, search box, Log In) and footer. Found by where they sit, not by tag: the job's title and Apply
 * button are inside a <header> element of the job pane, so excluding every <header> hid the very button that was wanted.
 */
const inSiteChrome = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top + window.scrollY < 165 || !!el.closest("footer, [role=contentinfo], [role=search]") || (!!el.closest("nav") && r.top + window.scrollY < 260);
};
const hash = (t: string) => [...t.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
const onLeft = (el: Element) => el.getBoundingClientRect().left < window.innerWidth * 0.45;

/** The cards of the list on the left, read by what is on screen (a heading with the title, the company line before it) when the cards carry no links. */
function readCardsByScreen(): JobCard[] {
  const out: JobCard[] = [];
  for (const h of deepAll<HTMLElement>("h2, h3, [role=heading]")) {
    const title = clean(h.textContent);
    if (!visible(h) || !onLeft(h) || title.length < 4 || title.length > 150 || /\bjobs?\s+in\b/i.test(title) || inSiteChrome(h)) continue;
    const card = (h.closest("article, li, [data-testid*='card' i]") ?? h.parentElement?.parentElement) as HTMLElement | null;
    const lines = (card?.innerText ?? "").split("\n").map(clean).filter(Boolean);
    const at = lines.findIndex((l) => title.startsWith(l) || l === title);
    const company = at > 0 ? lines[at - 1] : undefined;
    const place = lines.slice(Math.max(at, 0) + 1).find((l) => /,\s*[A-Z]{2}\b|remote|on-site|hybrid/i.test(l));
    out.push({ id: `zr-${hash(`${title}|${company ?? ""}`)}`, title, company, location: place, easy: /quick apply|1-click/i.test(card?.innerText ?? ""), url: location.href });
  }
  return out;
}

async function readSearchResults(send: Send): Promise<JobCard[]> {
  if (!(await ensureSignedIn(send))) throw new Error("ZipRecruiter was not signed in");
  // Either the jobs or ZipRecruiter's "No jobs found" page: the latter is answered at once so the run can loosen the search.
  await waitFor(() => (resultCount() !== null || document.querySelector(`${CARD}, ${LINKS}`) ? true : null), 20_000);
  if (resultCount() === 0) return [];
  await sleep(1_500);

  const found = new Map<string, JobCard>();
  for (let pass = 0; pass < 3 && found.size < MAX_JOBS_PER_SEARCH; pass++) {
    for (const a of deepAll<HTMLAnchorElement>(`${LINKS}, article a[href]`)) {
      const card = (a.closest(CARD) ?? a.closest("article, li, [role=listitem]")) as HTMLElement | null;
      if (!card) continue;
      const href = a.href;
      const id = card.id?.replace(/^job-card-?/, "") || href.match(/[?&]lvk=([\w.-]+)/)?.[1] || href.match(/[?&]lk=([\w.-]+)/)?.[1] || href.match(/\/Job\/([^/?]+)/i)?.[1] || "";
      if (!id || id.length < 4 || found.has(id)) continue;
      const lines = (card.innerText ?? "").split("\n").map(clean).filter(Boolean);
      const title = clean(card.querySelector("h2, h3, [data-testid='job-card-title']")?.textContent) || lines[0];
      if (!title) continue;
      const company = clean(card.querySelector("[data-testid='job-card-company'], [class*='company' i]")?.textContent) || lines[1] || undefined;
      const place = clean(card.querySelector("[data-testid='job-card-location'], [class*='location' i]")?.textContent) || undefined;
      found.set(id, { id, title, company, location: place, easy: /1-click apply|quick apply|easy apply/i.test(card.innerText), url: href });
    }
    if (found.size === 0) for (const j of readCardsByScreen()) if (!found.has(j.id)) found.set(j.id, j);
    window.scrollBy(0, 1500);
    await sleep(1_000);
  }
  // The page says it has jobs but none could be read: that is a problem with reading, not a reason to change the filters.
  if (found.size === 0 && (resultCount() ?? 0) > 0) throw new Error(`ZipRecruiter shows ${resultCount()} jobs but the list could not be read ${describePage()}`);
  return [...found.values()].slice(0, MAX_JOBS_PER_SEARCH);
}

/* ── the job page ─────────────────────────────────────────────────────── */

const OWN_APPLY = /^(1-click apply|quick apply|easy apply)$/i;
const OUTSIDE_APPLY = /^(apply|apply now|apply on (the )?(company|employer)['’]?s? (site|website)|apply on company site)$/i;

/** What a button says: its label if it has one (ZipRecruiter's buttons carry aria-label="Quick Apply"), else its text. */
const labelOf = (b: Element) => clean(b.getAttribute("aria-label") || b.textContent).replace(/\s*\(opens in a new tab\)/i, "");

function findApplyButton(): HTMLElement | null {
  // ZipRecruiter's own Apply button: <button data-testid="apply-now-button" aria-label="Quick Apply"> (or "Apply" for a company's site).
  const byTestId = deepAll<HTMLElement>('[data-testid="apply-now-button"], [data-testid*="apply" i][data-testid*="button" i], button[aria-label="Quick Apply"], button[aria-label="1-Click Apply"], button[aria-label="Apply"]').filter((b) => visible(b) && !inSiteChrome(b));
  if (byTestId.length) return byTestId.sort((x, y) => y.getBoundingClientRect().left - x.getBoundingClientRect().left)[0];

  const buttons = deepAll<HTMLElement>("button, a, [role=button]").filter((b) => {
    const text = labelOf(b);
    return visible(b) && text.length > 0 && text.length < 40 && (OWN_APPLY.test(text) || OUTSIDE_APPLY.test(text)) && !inSiteChrome(b);
  });
  // The detail pane sits to the right of the list of cards, so the right-most button is the job's own, not a "Quick apply" tag on a card.
  const rightMost = (list: HTMLElement[]) => [...list].sort((x, y) => y.getBoundingClientRect().left - x.getBoundingClientRect().left)[0];
  const own = buttons.filter((b) => OWN_APPLY.test(labelOf(b)));
  return (own.length ? rightMost(own) : buttons.length ? rightMost(buttons) : null) ?? null;
}

const isOwnApply = (b: HTMLElement) => OWN_APPLY.test(labelOf(b));
const alreadyApplied = () => deepAll<HTMLElement>("button, a, span, div").some((el) => el.children.length === 0 && visible(el) && /^(applied|you applied|application sent)$/i.test(clean(el.textContent)));
const sentNotice = () => /(your )?application (has been )?(sent|submitted)|you('ve| have) applied (to|for)|applied successfully|thank you for applying|application sent/i.test(clean(document.body?.innerText).slice(0, 6000));
const jobClosed = () => /no longer (available|accepting)|this job (has )?(expired|closed)|job (is )?(closed|expired)/i.test(clean(document.body?.innerText).slice(0, 3000));

const describePage = () => {
  const buttons = deepAll<HTMLElement>("button, a[role=button]").filter(visible).map((b) => `${clean(b.getAttribute("aria-label") || b.textContent).slice(0, 28)}${b.getAttribute("data-testid") ? `#${b.getAttribute("data-testid")}` : ""}`).filter(Boolean);
  return `[${location.pathname.slice(0, 50)} | buttons: ${[...new Set(buttons)].slice(0, 8).join(" / ") || "none"}]`;
};

/** A form on the page itself (ZipRecruiter's Quick Apply window, or its questions step). */
const formOnPage = () =>
  deepAll<HTMLElement>('[role="dialog"], [aria-modal="true"], form').some(
    (d) =>
      visible(d) &&
      !inSiteChrome(d) && !d.closest("[role=search]") &&
      deepAll<HTMLInputElement>("input:not([type=hidden]), select, textarea", d).some(
        (i) => visible(i) && i.type !== "search" && !inSiteChrome(i) && !i.closest("[role=search]") && !/search|location/i.test(`${i.name} ${i.getAttribute("aria-label") ?? ""} ${i.placeholder ?? ""}`)
      )
  );

function linkBehind(button: HTMLElement): string | undefined {
  const a = button.closest<HTMLAnchorElement>("a[href]") ?? button.querySelector<HTMLAnchorElement>("a[href]");
  const href = a?.href ?? button.getAttribute("data-href") ?? undefined;
  return href && /^https?:/i.test(href) ? href : undefined;
}

/** Runs `act`, and returns the address the page tried to open in a new window while it ran (see main-world.ts). */
async function captureOpen(act: () => void, ms: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const finish = (url: string | null) => {
      window.removeEventListener("message", onMessage);
      window.postMessage({ source: "cus-assist-isolated", type: "capture", on: false }, location.origin);
      clearTimeout(timer);
      resolve(url);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; url?: string } | null;
      if (event.source === window && data?.source === "cus-assist-main" && data.type === "open" && typeof data.url === "string") finish(data.url);
    };
    const timer = setTimeout(() => finish(null), ms);
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "cus-assist-isolated", type: "capture", on: true }, location.origin);
    setTimeout(act, 200);
  });
}

/**
 * Presses Apply. ZipRecruiter's own kinds are finished on this page (sent at once, or a form the shared driver fills);
 * the company's "Apply" opens the employer's site in another tab, which the run follows.
 */
async function handOver(job: JobCard, candidate: AssistCandidate | undefined, button: HTMLElement, send: Send): Promise<Result> {
  const label = `${job.title}${job.company ? ` at ${job.company}` : ""}`;
  await say(send, `${label}: clicking "${labelOf(button).slice(0, 30)}"`);
  const fromLink = linkBehind(button);
  const announced = await send<{ ok: boolean; seq: number }>({ type: "liApplyExternal", url: fromLink && !isOwnApply(button) ? fromLink : undefined, company: job.company });
  if (fromLink && !isOwnApply(button)) return { outcome: "EXTERNAL" };

  const before = location.href;
  const opened = await captureOpen(() => press(button), 5_000);
  if (opened) {
    await send({ type: "liApplyOpen", url: opened });
    return { outcome: "EXTERNAL" };
  }
  if (location.href !== before && !isZipRecruiterHost(location.hostname)) return { outcome: "EXTERNAL" };
  if (((await send<{ count: number }>({ type: "liApplyExtCount" }))?.count ?? 0) > 0) return { outcome: "EXTERNAL" };

  // Finished on this page: sent by the click itself, or a form came up.
  const seq = announced?.seq;
  // The Apply button turning into "Applied", or going away, also means it was sent (a form coming up is checked first).
  const buttonChanged = () => !document.contains(button) || /\b(applied|sent)\b/i.test(clean(button.textContent));
  const done = await waitFor(() => (formOnPage() ? "form" : sentNotice() || buttonChanged() ? "sent" : null), 12_000);
  if (done === "sent") {
    await send({ type: "liApplyResult", seq, kind: "job", outcome: "APPLIED", reason: "Sent with ZipRecruiter's own apply", pageUrl: location.href });
    return { outcome: "EXTERNAL" };
  }
  if (done === "form" && job && candidate && seq !== undefined) {
    await driveTask({ kind: "external", seq, job, candidate }, send);
    return { outcome: "EXTERNAL" };
  }
  await send({ type: "liApplyResult", seq, kind: "job", outcome: "FAILED", reason: `The Apply button did not lead anywhere ${describePage()}` });
  return { outcome: "EXTERNAL" };
}

const sameTitle = (text: string, title: string) => {
  const a = clean(text).toLowerCase();
  const b = clean(title).toLowerCase().slice(0, 40);
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a.slice(0, 40)));
};

/** Is this job's title the one shown in the detail pane on the right? (Read from any text there, not from one kind of heading.) */
const detailShows = (title: string) =>
  deepAll<HTMLElement>("h1, h2, h3, div, span, p").some((el) => el.children.length <= 1 && visible(el) && !onLeft(el) && !inSiteChrome(el) && clean(el.textContent).length < 160 && sameTitle(el.textContent ?? "", title));

/** The card on the left for this job: its title (a heading, link or bold line) and the box around it. */
function cardFor(job: JobCard): { title: HTMLElement; box: HTMLElement; link?: HTMLAnchorElement } | null {
  const title = deepAll<HTMLElement>("h2, h3, [role=heading], a, div, span").find((el) => el.children.length <= 1 && visible(el) && onLeft(el) && !inSiteChrome(el) && clean(el.textContent).length < 160 && sameTitle(el.textContent ?? "", job.title));
  if (!title) return null;
  const box = (title.closest("article, li, [data-testid*='card' i], [role=listitem]") ?? title.parentElement?.parentElement ?? title) as HTMLElement;
  const link = title.closest<HTMLAnchorElement>("a[href]") ?? box.querySelector<HTMLAnchorElement>("a[href]") ?? undefined;
  return { title, box, link };
}

/**
 * Makes sure the pane on the right shows THIS job (the page opens on whichever job ZipRecruiter picked first). It clicks the
 * job's title, then its box, then follows its link, and goes on to the next way if the pane has not changed after each.
 */
async function showJob(job: JobCard): Promise<boolean> {
  if (detailShows(job.title)) return true;
  for (let pass = 0; pass < 2; pass++) {
    const card = cardFor(job);
    if (!card) {
      window.scrollBy(0, 600); // the card may be further down the list
      await sleep(800);
      continue;
    }
    for (const target of [card.title, card.box, card.title.closest<HTMLElement>("a, button, [role=button]")].filter((t): t is HTMLElement => !!t)) {
      press(target);
      if (await waitFor(() => (detailShows(job.title) ? true : null), 3_500)) return true;
    }
    if (card.link?.href && !card.link.href.startsWith("javascript:") && card.link.href !== location.href) {
      location.assign(card.link.href); // the page reloads on that job; the run picks up there
      await sleep(15_000);
      return detailShows(job.title);
    }
  }
  return false;
}

async function applyOnZipRecruiter(job: JobCard, candidate: AssistCandidate | undefined, send: Send): Promise<Result> {
  const fail = (reason: string) => ({ outcome: "FAILED" as const, reason });
  await say(send, `opening ${job.title}${job.company ? ` at ${job.company}` : ""}`);
  if (!(await clearChallenge(send))) return fail("Verification was not completed in time");
  if (!(await ensureSignedIn(send))) return fail("ZipRecruiter was not signed in");

  await sleep(1_500);
  if (!(await showJob(job))) return fail(`Could not open "${job.title}" from ZipRecruiter's list ${describePage()}`);

  const button = await waitFor(findApplyButton, 15_000);
  if (!button) {
    if (needsSignIn() && !(await ensureSignedIn(send))) return fail("ZipRecruiter was not signed in");
    if (alreadyApplied()) return { outcome: "SKIPPED", reason: "Already applied" };
    if (jobClosed()) return { outcome: "SKIPPED", reason: "The job is closed" };
    return { outcome: "SKIPPED", reason: `No Apply button on this job ${describePage()}` };
  }
  return handOver(job, candidate, button, send);
}

/** A ZipRecruiter tab that is not the run's own job page: carry on to the company's site. */
async function leaveZipRecruiter(task: { seq: number }, send: Send) {
  await say(send, "ZipRecruiter: heading to the company's site", true);
  const here = location.href;
  await sleep(4_000);
  if (!isZipRecruiterHost(location.hostname) || location.href !== here) return;

  const outward = deepAll<HTMLAnchorElement>("a[href]").filter((a) => /^https?:/i.test(a.href) && !isZipRecruiterHost(new URL(a.href).hostname) && visible(a));
  const preferred = outward.find((a) => /apply|continue|company|employer|go to|visit/i.test(clean(a.textContent))) ?? outward[0];
  if (preferred) {
    location.assign(preferred.href);
    return;
  }
  const apply = findApplyButton();
  if (apply && !isOwnApply(apply)) {
    const target = linkBehind(apply) ?? (await captureOpen(() => press(apply), 5_000));
    if (target) {
      location.assign(target);
      return;
    }
    await sleep(3_000);
    if (!isZipRecruiterHost(location.hostname) || location.href !== here) return;
  }
  await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: `ZipRecruiter's page did not lead to the company's site. It said: "${clean(document.body?.innerText).slice(0, 120)}" ${describePage()}` });
}

/** Content-script entry: if this tab is a ZipRecruiter run's tab, do the task for this page and report back. */
export async function runZipRecruiterApplyIfAsked(send: Send) {
  if (window !== window.top || !isZipRecruiterHost(location.hostname)) return;
  const task = await send<Task | null>({ type: "liApplyTask" });
  if (!task?.kind) return;

  if (task.kind === "external") {
    if (!task.own) return void (await leaveZipRecruiter(task, send));
    // The run's own job page after the Apply click: a form that came up is filled; if the page was reloaded before the click
    // went through, Apply is clicked again.
    const tabs = async () => (await send<{ count: number }>({ type: "liApplyExtCount" }))?.count ?? 0;
    await say(send, "waiting for the application", true);
    for (let attempt = 0; attempt < 3 && task.job; attempt++) {
      await sleep(4_000);
      if ((await tabs()) > 0) return;
      if (sentNotice()) return void (await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "APPLIED", reason: "Sent with ZipRecruiter's own apply", pageUrl: location.href }));
      if (formOnPage() && task.candidate) return void (await driveTask({ kind: "external", seq: task.seq, job: task.job, candidate: task.candidate }, send));
      if (!(await ensureSignedIn(send))) return;
      if (!(await showJob(task.job))) continue;
      const button = findApplyButton();
      if (!button) continue;
      const r = await handOver(task.job, task.candidate, button, send);
      if (r.outcome !== "EXTERNAL") return void (await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r }));
      return;
    }
    return;
  }

  await say(send, task.kind === "search" ? "reading ZipRecruiter's search results" : `ZipRecruiter: ${task.job?.title ?? "job"}`, true);
  try {
    if (!(await clearChallenge(send))) throw new Error("Verification was not completed in time");
    if (task.kind === "search") {
      await send({ type: "liApplyResult", seq: task.seq, kind: "search", jobs: await readSearchResults(send) });
    } else if (task.job) {
      for (let left = Math.round((task.delayMs ?? 0) / 1000); left > 0; left--) {
        await say(send, `next application in ${left}s: ${task.job.title}`, true);
        await sleep(1_000);
      }
      const r = await applyOnZipRecruiter(task.job, task.candidate, send);
      if (r.outcome !== "EXTERNAL") await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read ZipRecruiter";
    await say(send, `problem: ${message}`);
    if (task.kind === "job") await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: message });
    else await send({ type: "liApplyResult", seq: task.seq, kind: task.kind, error: message });
  }
}
