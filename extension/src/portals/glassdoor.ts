import type { AssistCandidate } from "../../../lib/automation/formEngine";
import { isGlassdoorHost, isPortalHost, MAX_JOBS_PER_SEARCH, type ApplyOutcome, type JobCard } from "../linkedin-shared";
import { clean, clearChallenge, deepAll, press, say, sleep, visible, waitFor, type Send } from "../linkedin-apply";
import { waitForPerson } from "../external-apply";

/**
 * GLASSDOOR. Everything here is about Glassdoor's own pages only (see PLAYBOOKS.md for the steps and what Glassdoor does
 * and does not have). The run works from the candidate's own signed-in browser:
 *
 *   search page  -> read the job cards
 *   job page     -> click "Apply on employer site" (or "Easy Apply")
 *   next page    -> Glassdoor sends the browser on to the employer's site, or to Indeed's application form
 *   that site    -> filled and submitted by the company-site driver (external-apply.ts)
 *
 * The step that tends to stick is the hand-over from Glassdoor to the employer. It is tried three ways, in this order:
 * the link behind the button; the address the button's script opens (caught, then opened by the extension, because a
 * pop-up from a script-made click is blocked); the address in the page's own data. If none works the failure says what
 * the page showed. Signing in stays with the candidate.
 */

/* ── signing in ───────────────────────────────────────────────────────── */

function needsSignIn(): boolean {
  if (/\/(profile\/login|member\/auth|login|signin)/i.test(location.pathname)) return true;
  if (deepAll<HTMLInputElement>('input[type="password"]').some(visible)) return true;
  // The sign-in pop-up Glassdoor puts over a job: a dialog that asks for an email address.
  return deepAll<HTMLElement>('[role="dialog"], [data-test*="modal" i]').some(
    (d) => visible(d) && /sign in|log in|welcome back|join glassdoor|create (an )?account/i.test(d.innerText) && deepAll<HTMLInputElement>("input", d).some((i) => visible(i) && /email|text/.test(i.type))
  );
}

/** False if the candidate never signed in. */
async function ensureSignedIn(send: Send): Promise<boolean> {
  if (!needsSignIn()) return true;
  const ok = await waitForPerson(send, "Glassdoor needs the candidate to sign in. Sign in in this window and the run continues.", () => !needsSignIn());
  await sleep(1_500);
  return ok;
}

/* ── search results ───────────────────────────────────────────────────── */

const idOf = (a: HTMLAnchorElement, card: Element | null) =>
  a.href.match(/[?&]jl=(\d+)/)?.[1] ?? card?.getAttribute("data-jobid") ?? card?.getAttribute("data-id") ?? a.href.match(/_JV_[^?]*?(\d{6,})/)?.[1] ?? "";

async function readSearchResults(send: Send): Promise<JobCard[]> {
  if (!(await ensureSignedIn(send))) throw new Error("Glassdoor was not signed in");
  await waitFor(() => document.querySelector('li[data-test="jobListing"], a[data-test="job-link"], a[href*="jl="]'), 20_000);

  const found = new Map<string, JobCard>();
  for (let pass = 0; pass < 4 && found.size < MAX_JOBS_PER_SEARCH; pass++) {
    for (const a of deepAll<HTMLAnchorElement>('a[data-test="job-link"], a[href*="/job-listing/"], a[href*="jl="]')) {
      const card = (a.closest('li[data-test="jobListing"], li') ?? a.parentElement) as HTMLElement | null;
      const id = idOf(a, card);
      if (!id || found.has(id)) continue;
      const text = card?.innerText ?? "";
      const lines = text.split("\n").map(clean).filter(Boolean);
      const title = clean(a.textContent) || lines[0];
      if (!title) continue;
      // A card reads: rating, company, title, location, salary, "Easy Apply"... in an order that changes, so the labelled parts come first.
      const at = lines.findIndex((l) => l === title || l.startsWith(title));
      const before = lines.slice(0, Math.max(at, 0)).filter((l) => !/^[\d.]+\s*★?$/.test(l) && !/★/.test(l));
      const company = clean(card?.querySelector('[data-test="employer-short-name"], [class*="EmployerProfile_compactEmployerName"], [class*="employerName"]')?.textContent) || before.at(-1);
      const place = clean(card?.querySelector('[data-test="emp-location"], [class*="location"]')?.textContent) || (at >= 0 ? lines[at + 1] : undefined);
      found.set(id, { id, title, company, location: place, easy: /easy apply/i.test(text), url: a.href });
    }
    // More results load behind a button or as the list is scrolled.
    deepAll<HTMLElement>("button").find((b) => visible(b) && /show more jobs|load more/i.test(clean(b.textContent)))?.click();
    window.scrollBy(0, 1500);
    await sleep(1_200);
  }
  return [...found.values()].slice(0, MAX_JOBS_PER_SEARCH);
}

/* ── the job page and the hand-over to the employer ───────────────────── */

/** Any button or link whose words start with "Apply" or "Easy Apply" ("Apply on employer site", "Apply now", "Apply"...). */
const APPLY_STARTS = /^(easy\s+)?apply\b/i;
const NOT_AN_APPLY_BUTTON = /applied|filter|applicant|application|alert|saved/i;

function findApplyButton(): HTMLElement | null {
  const labelled = deepAll<HTMLElement>('[data-test="applyButton"], [data-test="easyApply"], [data-test="apply-button"]').find(visible);
  if (labelled) return labelled;
  const candidates = deepAll<HTMLElement>("button, a, [role=button]").filter((b) => {
    const text = clean(b.textContent);
    return visible(b) && text.length > 0 && text.length < 40 && APPLY_STARTS.test(text) && !NOT_AN_APPLY_BUTTON.test(text) && !b.closest("header, nav, footer");
  });
  // The one that says where it goes ("on employer site") or "Easy Apply" is the real one; otherwise the first.
  return candidates.find((b) => /employer|company|easy apply/i.test(clean(b.textContent))) ?? candidates[0] ?? null;
}

const alreadyApplied = () => deepAll<HTMLElement>("button, a, span, div").some((el) => el.children.length === 0 && visible(el) && /^applied$/i.test(clean(el.textContent)));

/** What the page shows, for a failure message that says something. */
const describePage = () => {
  const buttons = deepAll<HTMLElement>("button, a[role=button]").filter(visible).map((b) => clean(b.textContent).slice(0, 28)).filter(Boolean);
  return `[${location.pathname.slice(0, 50)} | buttons: ${[...new Set(buttons)].slice(0, 8).join(" / ") || "none"}]`;
};

/** The address behind the Apply button, if it is a link (or sits inside one). */
function linkBehind(button: HTMLElement): string | undefined {
  const a = button.closest<HTMLAnchorElement>("a[href]") ?? button.querySelector<HTMLAnchorElement>("a[href]");
  const href = a?.href ?? button.getAttribute("data-href") ?? button.getAttribute("data-url") ?? undefined;
  return href && /^https?:/i.test(href) && !/^javascript:/i.test(href) ? href : undefined;
}

/** The apply address in the data Glassdoor puts in the page, if there is one. */
function applyUrlFromPageData(): string | undefined {
  const raw = document.getElementById("__NEXT_DATA__")?.textContent;
  if (!raw) return undefined;
  try {
    let found: string | undefined;
    const walk = (value: unknown, depth: number) => {
      if (found || depth > 12 || !value || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string" && /apply.*url|applyurl/i.test(key) && /^(https?:|\/partner\/)/.test(v)) {
          found = v;
          return;
        }
        walk(v, depth + 1);
      }
    };
    walk(JSON.parse(raw), 0);
    return found ? new URL(found, location.origin).href : undefined;
  } catch {
    return undefined;
  }
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
    // The switch is delivered as a message, so give it a moment before the click.
    setTimeout(act, 200);
  });
}

export async function applyOnGlassdoor(job: JobCard, send: Send): Promise<{ outcome: ApplyOutcome | "EXTERNAL"; reason?: string }> {
  const fail = (reason: string) => ({ outcome: "FAILED" as const, reason });
  const label = `${job.title}${job.company ? ` at ${job.company}` : ""}`;

  await say(send, `opening ${label}`);
  if (!(await clearChallenge(send))) return fail("Verification was not completed in time");
  if (!(await ensureSignedIn(send))) return fail("Glassdoor was not signed in");

  const button = await waitFor(findApplyButton, 15_000);
  if (!button) {
    if (needsSignIn() && !(await ensureSignedIn(send))) return fail("Glassdoor was not signed in");
    if (alreadyApplied()) return { outcome: "SKIPPED", reason: "Already applied" };
    return { outcome: "SKIPPED", reason: `No Apply button on this job (it may be closed) ${describePage()}` };
  }
  if (alreadyApplied()) return { outcome: "SKIPPED", reason: "Already applied" };

  await say(send, `${label}: going to the employer's application`);
  const fromLink = linkBehind(button);
  // Announced before the click, so the tab that opens is recognised as part of this application.
  const announced = await send<{ ok: boolean; seq: number }>({ type: "liApplyExternal", url: fromLink, company: job.company });
  if (fromLink) return { outcome: "EXTERNAL" };

  const before = location.href;
  const opened = await captureOpen(() => press(button), 6_000);
  if (opened) {
    await send({ type: "liApplyOpen", url: opened });
    return { outcome: "EXTERNAL" };
  }
  if (location.href !== before) return { outcome: "EXTERNAL" }; // the button took this tab to the next page itself
  if (((await send<{ count: number }>({ type: "liApplyExtCount" }))?.count ?? 0) > 0) return { outcome: "EXTERNAL" };

  const fromData = applyUrlFromPageData();
  if (fromData) {
    await send({ type: "liApplyOpen", url: fromData });
    return { outcome: "EXTERNAL" };
  }
  // Nothing worked: say so now (with what the page showed), not after minutes of waiting.
  await send({ type: "liApplyResult", seq: announced?.seq, kind: "job", outcome: "FAILED", reason: `The Apply button did not lead anywhere ${describePage()}` });
  return { outcome: "EXTERNAL" };
}

/**
 * The page Glassdoor shows between its job page and the employer ("Apply on the company's website", a redirect notice).
 * It normally forwards the browser by itself; if it waits for a click, the click is made here.
 */
async function leaveGlassdoor(task: { seq: number }, send: Send) {
  await say(send, "Glassdoor: heading to the employer's site", true);
  const here = location.href;
  await sleep(4_000);
  if (!isGlassdoorHost(location.hostname) || location.href !== here) return;

  const outward = deepAll<HTMLAnchorElement>("a[href]").filter((a) => /^https?:/i.test(a.href) && !isPortalHost(new URL(a.href).hostname) && visible(a));
  const preferred = outward.find((a) => /apply|continue|company|employer|go to|visit/i.test(clean(a.textContent))) ?? outward[0];
  if (preferred) {
    location.assign(preferred.href);
    return;
  }
  const proceed = deepAll<HTMLElement>("button, a").find((b) => visible(b) && /^(continue|proceed|apply on (the )?(company|employer).*|go to .*|continue to .*)$/i.test(clean(b.textContent)));
  if (proceed) {
    press(proceed);
    await sleep(5_000);
    if (!isGlassdoorHost(location.hostname) || location.href !== here) return;
  }
  const said = clean(document.body?.innerText).slice(0, 120);
  await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: `Glassdoor's page did not lead to the employer's site. It said: "${said}" ${describePage()}` });
}

/** Content-script entry: if this tab is a Glassdoor run's tab, do the task for this page and report back. */
export async function runGlassdoorApplyIfAsked(send: Send) {
  if (window !== window.top || !isGlassdoorHost(location.hostname)) return;
  const task = await send<{ kind: "search" | "job" | "external"; seq: number; job?: JobCard; candidate?: AssistCandidate; delayMs?: number } | null>({ type: "liApplyTask" });
  if (!task?.kind) return;

  if (task.kind === "external") {
    // The run's own job page just waits (the employer's site opens in another tab). Any other Glassdoor page in the chain is passed through.
    if (!/\/(job-listing|Job)\//i.test(location.pathname)) await leaveGlassdoor(task, send);
    else await say(send, "waiting for the employer's site (it opens in its own tab)", true);
    return;
  }
  await say(send, task.kind === "search" ? "reading Glassdoor's search results" : `Glassdoor: ${task.job?.title ?? "job"}`, true);
  try {
    if (!(await clearChallenge(send))) throw new Error("Verification was not completed in time");
    if (task.kind === "search") {
      await send({ type: "liApplyResult", seq: task.seq, kind: "search", jobs: await readSearchResults(send) });
    } else if (task.job) {
      for (let left = Math.round((task.delayMs ?? 0) / 1000); left > 0; left--) {
        await say(send, `next application in ${left}s: ${task.job.title}`, true);
        await sleep(1_000);
      }
      const r = await applyOnGlassdoor(task.job, send);
      if (r.outcome !== "EXTERNAL") await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read Glassdoor";
    await say(send, `problem: ${message}`);
    // A problem on one job is that job's failure; the run goes on to the next one. Only a failed search ends the run.
    if (task.kind === "job") await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: message });
    else await send({ type: "liApplyResult", seq: task.seq, kind: task.kind, error: message });
  }
}
