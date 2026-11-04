import type { AssistCandidate } from "../../../lib/automation/formEngine";
import { isIndeedHost, isPortalHost, MAX_JOBS_PER_SEARCH, type ApplyOutcome, type JobCard } from "../linkedin-shared";
import { clean, clearChallenge, deepAll, press, say, sleep, visible, waitFor, type Send } from "../linkedin-apply";
import { driveTask, waitForPerson } from "../external-apply";

/**
 * INDEED. Everything here is about Indeed's own pages only (see PLAYBOOKS.md for the steps and what Indeed does and does
 * not have). The run works from the candidate's own signed-in browser:
 *
 *   search page   -> read the job cards
 *   job page      -> click "Apply now" (Indeed's own form) or "Apply on company site"
 *   smartapply.*  -> Indeed's own application form: filled and submitted by the shared form driver (external-apply.ts)
 *   company site  -> Indeed sends the browser on (through an in-between page); the shared driver fills and submits it there
 *
 * The hand-over to the next page is tried in this order: the link behind the button; the address the button's script
 * opens (caught, then opened by the extension, because a pop-up from a script-made click is blocked); the address in
 * the page's own data. Signing in and verification stay with the candidate (the run waits).
 */

/* ── signing in ───────────────────────────────────────────────────────── */

function needsSignIn(): boolean {
  if (/^secure\./i.test(location.hostname) || /\/(auth|account\/login|login)(\/|$|\?)/i.test(location.pathname)) return true;
  return deepAll<HTMLInputElement>('input[type="password"]').some(visible);
}

/** False if the candidate never signed in. */
async function ensureSignedIn(send: Send): Promise<boolean> {
  if (!needsSignIn()) return true;
  const ok = await waitForPerson(send, "Indeed needs the candidate to sign in. Sign in in this window and the run continues.", () => !needsSignIn());
  await sleep(1_500);
  return ok;
}

/* ── Indeed's updated terms ───────────────────────────────────────────── */

/** The "Updates to our Terms of Service" pop-up. Accepting it is the candidate's own agreement (it includes an arbitration clause), so it is never clicked for them. */
const termsShown = () => deepAll<HTMLElement>('[role="dialog"], [aria-modal="true"], [class*="modal" i]').some((d) => visible(d) && /terms of service/i.test(d.innerText) && /accept terms/i.test(d.innerText));

/** If the terms pop-up is up, the run waits (10 minutes) for the candidate to read and accept it, then goes on. False if they never did. */
async function clearTerms(send: Send): Promise<boolean> {
  if (!termsShown()) return true;
  const ok = await waitForPerson(send, "Indeed is asking to accept its updated Terms of Service. Read it and click Accept Terms and the run continues.", () => !termsShown());
  await sleep(1_000);
  return ok;
}

/* ── search results ───────────────────────────────────────────────────── */

async function readSearchResults(send: Send): Promise<JobCard[]> {
  if (!(await ensureSignedIn(send))) throw new Error("Indeed was not signed in");
  if (!(await clearTerms(send))) throw new Error("Indeed's terms were not accepted");
  await waitFor(() => document.querySelector('a[data-jk], a.jcs-JobTitle, .job_seen_beacon, [data-testid="slider_item"]'), 20_000);

  const found = new Map<string, JobCard>();
  for (let pass = 0; pass < 3 && found.size < MAX_JOBS_PER_SEARCH; pass++) {
    for (const a of deepAll<HTMLAnchorElement>("a[data-jk], a.jcs-JobTitle, h2.jobTitle a")) {
      const id = a.getAttribute("data-jk") ?? a.href.match(/[?&]jk=([0-9a-f]+)/i)?.[1] ?? "";
      if (!id || found.has(id)) continue;
      const card = (a.closest(".job_seen_beacon, [data-testid='slider_item'], li, td.resultContent") ?? a.parentElement) as HTMLElement | null;
      const title = clean(a.getAttribute("title") ?? a.textContent) || clean(card?.querySelector("h2")?.textContent);
      if (!title) continue;
      const company = clean(card?.querySelector('[data-testid="company-name"], .companyName')?.textContent) || undefined;
      const place = clean(card?.querySelector('[data-testid="text-location"], [data-testid="job-location"], .companyLocation')?.textContent) || undefined;
      const easy = !!card?.querySelector('[data-testid="indeedApply"], .iaIcon, .indeed-apply-badge') || /easily apply/i.test(card?.innerText ?? "");
      found.set(id, { id, title, company, location: place, easy, url: `${location.origin}/viewjob?jk=${id}` });
    }
    window.scrollBy(0, 1500);
    await sleep(1_000);
  }
  return [...found.values()].slice(0, MAX_JOBS_PER_SEARCH);
}

/* ── the job page and the hand-over ───────────────────────────────────── */

const APPLY_TEXT = /^(apply now|apply on (the )?(company|employer)['’]?s? (site|website)|apply on company site|easily apply|apply)$/i;

function findApplyButton(): HTMLElement | null {
  const labelled = deepAll<HTMLElement>('#indeedApplyButton, [data-testid="indeedApplyButton"], button[id*="applyButton" i], #applyButtonLinkContainer a, #applyButtonLinkContainer button, a[href*="applystart"]').find(visible);
  if (labelled) return labelled;
  return (
    deepAll<HTMLElement>("button, a, [role=button]").find((b) => {
      const text = clean(b.textContent).replace(/\s*\(opens in a new tab\)/i, "");
      return visible(b) && text.length < 40 && APPLY_TEXT.test(text) && !b.closest("header, nav, footer");
    }) ?? null
  );
}

const alreadyApplied = () => /you('ve| have)? applied|application submitted/i.test(clean(document.querySelector("#jobsearch-ViewjobPaneWrapper, .jobsearch-ViewJobLayout-jobDisplay, main")?.textContent).slice(0, 4000)) && !findApplyButton();
const jobClosed = () => /no longer (available|accepting)|this job has expired|job (has )?expired/i.test(clean(document.body?.innerText).slice(0, 3000));

const describePage = () => {
  const buttons = deepAll<HTMLElement>("button, a[role=button]").filter(visible).map((b) => clean(b.textContent).slice(0, 28)).filter(Boolean);
  return `[${location.pathname.slice(0, 50)} | buttons: ${[...new Set(buttons)].slice(0, 8).join(" / ") || "none"}]`;
};

function linkBehind(button: HTMLElement): string | undefined {
  const a = button.closest<HTMLAnchorElement>("a[href]") ?? button.querySelector<HTMLAnchorElement>("a[href]");
  const href = a?.href ?? button.getAttribute("href") ?? button.getAttribute("data-href") ?? undefined;
  return href && /^https?:/i.test(href) ? href : undefined;
}

/** The apply address in the data Indeed puts in the page, if there is one. */
function applyUrlFromPageData(): string | undefined {
  for (const script of deepAll<HTMLScriptElement>('script[type="application/json"], script#mosaic-data, script[id*="data" i]')) {
    const m = script.textContent?.match(/"(?:applyUrl|indeedApplyUrl|applyLink)"\s*:\s*"([^"]+)"/);
    if (m) {
      try {
        return new URL(JSON.parse(`"${m[1]}"`), location.origin).href;
      } catch {
        /* not a usable address */
      }
    }
  }
  return undefined;
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

type Result = { outcome: ApplyOutcome | "EXTERNAL"; reason?: string };

/** Clicks Apply and gets the next page (Indeed's form or the company's site) opened. Safe to run again. */
async function handOver(job: JobCard, button: HTMLElement, send: Send): Promise<Result> {
  const label = `${job.title}${job.company ? ` at ${job.company}` : ""}`;
  await say(send, `${label}: clicking "${clean(button.textContent).slice(0, 30)}"`);
  const fromLink = linkBehind(button);
  // Announced before the click, so the tab that opens is recognised as part of this application.
  const announced = await send<{ ok: boolean; seq: number }>({ type: "liApplyExternal", url: fromLink, company: job.company });
  if (fromLink && !/^javascript:/i.test(fromLink)) return { outcome: "EXTERNAL" };

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
  await send({ type: "liApplyResult", seq: announced?.seq, kind: "job", outcome: "FAILED", reason: `The Apply button did not lead anywhere ${describePage()}` });
  return { outcome: "EXTERNAL" };
}

async function applyOnIndeed(job: JobCard, send: Send): Promise<Result> {
  const fail = (reason: string) => ({ outcome: "FAILED" as const, reason });
  await say(send, `opening ${job.title}${job.company ? ` at ${job.company}` : ""}`);
  if (!(await clearChallenge(send))) return fail("Verification was not completed in time");
  if (!(await ensureSignedIn(send))) return fail("Indeed was not signed in");
  if (!(await clearTerms(send))) return fail("Indeed's terms were not accepted");

  const button = await waitFor(findApplyButton, 15_000);
  if (!button) {
    if (needsSignIn() && !(await ensureSignedIn(send))) return fail("Indeed was not signed in");
    if (alreadyApplied()) return { outcome: "SKIPPED", reason: "Already applied" };
    if (jobClosed()) return { outcome: "SKIPPED", reason: "The job is closed" };
    return { outcome: "SKIPPED", reason: `No Apply button on this job ${describePage()}` };
  }
  return handOver(job, button, send);
}

/**
 * Indeed's in-between page (it forwards the browser to the company's site). Normally it does so by itself; if it waits for a
 * click, the click is made here.
 */
async function leaveIndeed(task: { seq: number }, send: Send) {
  await say(send, "Indeed: heading to the next page", true);
  const here = location.href;
  await sleep(4_000);
  if (!isIndeedHost(location.hostname) || location.href !== here) return;

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
    if (!isIndeedHost(location.hostname) || location.href !== here) return;
  }
  const apply = findApplyButton();
  if (apply) {
    const target = linkBehind(apply) ?? (await captureOpen(() => press(apply), 6_000)) ?? applyUrlFromPageData();
    if (target) {
      location.assign(target);
      return;
    }
    await sleep(3_000);
    if (!isIndeedHost(location.hostname) || location.href !== here) return;
  }
  const said = clean(document.body?.innerText).slice(0, 120);
  await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: `Indeed's page did not lead to the company's site. It said: "${said}" ${describePage()}` });
}

/** Content-script entry: if this tab is an Indeed run's tab, do the task for this page and report back. */
export async function runIndeedApplyIfAsked(send: Send) {
  if (window !== window.top || !isIndeedHost(location.hostname)) return;
  const task = await send<{ kind: "search" | "job" | "external"; seq: number; job?: JobCard; candidate?: AssistCandidate; delayMs?: number; own?: boolean } | null>({ type: "liApplyTask" });
  if (!task?.kind) return;

  if (task.kind === "external") {
    // Indeed's own application form: filled and submitted by the shared form driver.
    if (/^smartapply\./i.test(location.hostname) || /\/(apply|beta\/indeedapply)\b/i.test(location.pathname)) {
      if (task.job && task.candidate) await driveTask({ kind: "external", seq: task.seq, job: task.job, candidate: task.candidate }, send);
      return;
    }
    // Any Indeed tab other than the run's own job page is an in-between page: carry on to the company.
    if (!task.own) {
      await leaveIndeed(task, send);
      return;
    }
    await say(send, "waiting for the next page (it opens in its own tab)", true);
    // If the page was reloaded before the click went through, no new tab exists a few seconds later: click Apply again.
    const tabs = async () => (await send<{ count: number }>({ type: "liApplyExtCount" }))?.count ?? 0;
    for (let attempt = 0; attempt < 3 && task.job; attempt++) {
      await sleep(5_000);
      if ((await tabs()) > 0) return;
      if (!(await ensureSignedIn(send)) || !(await clearTerms(send))) return;
      const button = findApplyButton();
      if (!button) continue;
      const r = await handOver(task.job, button, send);
      if (r.outcome !== "EXTERNAL") return void (await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r }));
      await sleep(4_000);
      if ((await tabs()) > 0) return;
    }
    return;
  }

  await say(send, task.kind === "search" ? "reading Indeed's search results" : `Indeed: ${task.job?.title ?? "job"}`, true);
  try {
    if (!(await clearChallenge(send))) throw new Error("Verification was not completed in time");
    if (task.kind === "search") {
      await send({ type: "liApplyResult", seq: task.seq, kind: "search", jobs: await readSearchResults(send) });
    } else if (task.job) {
      for (let left = Math.round((task.delayMs ?? 0) / 1000); left > 0; left--) {
        await say(send, `next application in ${left}s: ${task.job.title}`, true);
        await sleep(1_000);
      }
      const r = await applyOnIndeed(task.job, send);
      if (r.outcome !== "EXTERNAL") await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read Indeed";
    await say(send, `problem: ${message}`);
    if (task.kind === "job") await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: message });
    else await send({ type: "liApplyResult", seq: task.seq, kind: task.kind, error: message });
  }
}
