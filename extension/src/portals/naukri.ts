import type { AssistCandidate } from "../../../lib/automation/formEngine";
import { isNaukriHost, MAX_JOBS_PER_SEARCH, type ApplyOutcome, type JobCard } from "../linkedin-shared";
import { clean, clearChallenge, deepAll, press, say, sleep, visible, waitFor, type Send } from "../linkedin-apply";
import { driveTask, waitForPerson } from "../external-apply";

/**
 * NAUKRI. Everything here is about Naukri's own pages only (see PLAYBOOKS.md for the steps and what Naukri does and does
 * not have). The run works from the candidate's own signed-in browser:
 *
 *   search page  -> read the job cards
 *   job page     -> "Apply" (Naukri's own: sent from the page, sometimes followed by a short questions panel), or
 *                   "Apply on company site" (the employer's own site, another tab)
 *   company site -> filled and submitted by the shared form driver (external-apply.ts)
 *
 * Signing in and verification stay with the candidate (the run waits).
 */

type Result = { outcome: ApplyOutcome | "EXTERNAL"; reason?: string };
type Task = { kind: "search" | "job" | "external"; seq: number; job?: JobCard; candidate?: AssistCandidate; delayMs?: number; own?: boolean };

/* ── signing in ───────────────────────────────────────────────────────── */

function needsSignIn(): boolean {
  if (/\/(nlogin|login|registration)/i.test(location.pathname)) return true;
  return deepAll<HTMLInputElement>('input[type="password"]').some(visible);
}

async function ensureSignedIn(send: Send): Promise<boolean> {
  if (!needsSignIn()) return true;
  const ok = await waitForPerson(send, "Naukri needs the candidate to sign in. Sign in in this window and the run continues.", () => !needsSignIn());
  await sleep(1_500);
  return ok;
}

/* ── search results ───────────────────────────────────────────────────── */

const CARD = ".srp-jobtuple-wrapper, .cust-job-tuple, [data-job-id], article.jobTuple";
const noResults = () => /no results found|no jobs found|couldn['’]t find any|did not match any jobs/i.test(document.body?.innerText ?? "");

async function readSearchResults(send: Send): Promise<JobCard[]> {
  if (!(await ensureSignedIn(send))) throw new Error("Naukri was not signed in");
  // Either the cards or Naukri's "no results" page: the latter is answered at once so the run can loosen the search.
  await waitFor(() => (document.querySelector(CARD) ? true : noResults() ? true : null), 20_000);
  if (!document.querySelector(CARD)) {
    if (noResults()) return [];
    throw new Error(`Naukri's job list could not be read ${describePage()}`);
  }
  await sleep(1_000);

  const found = new Map<string, JobCard>();
  for (const card of deepAll<HTMLElement>(CARD)) {
    const link = card.querySelector<HTMLAnchorElement>("a.title, a[class*='title' i][href], h2 a[href]");
    if (!link) continue;
    const id = card.getAttribute("data-job-id") ?? link.href.match(/-(\d{8,})(?:\?|$)/)?.[1] ?? "";
    const title = clean(link.getAttribute("title") ?? link.textContent);
    if (!id || !title || found.has(id)) continue;
    const company = clean(card.querySelector("a.comp-name, [class*='comp-name' i], [class*='companyInfo' i] a")?.textContent) || undefined;
    const place = clean(card.querySelector(".locWdth, .loc-wrap, [class*='location' i], .locWdth")?.textContent) || undefined;
    found.set(id, { id, title, company, location: place, easy: false, url: link.href });
    if (found.size >= MAX_JOBS_PER_SEARCH) break;
  }
  if (found.size === 0) throw new Error(`Naukri's job cards could not be read ${describePage()}`);
  return [...found.values()];
}

/* ── the job page ─────────────────────────────────────────────────────── */

const labelOf = (b: Element) => clean(b.getAttribute("aria-label") || b.textContent);
const COMPANY_SITE = /^apply on (the )?(company|employer)['’]?s? (site|website)$/i;
const OWN_APPLY = /^(apply|apply now|easy apply)$/i;

/** Naukri's own "Apply" button (sent from the page). */
const findOwnApply = (): HTMLElement | null =>
  deepAll<HTMLElement>("#apply-button, button.apply-button, button[id*='apply-button' i], button, a, [role=button]").find((b) => visible(b) && OWN_APPLY.test(labelOf(b)) && !b.closest("header, nav, footer, [class*='similar' i], [class*='recommend' i]")) ?? null;

/** "Apply on company site": leads to the employer's own site. */
const findCompanySite = (): HTMLElement | null =>
  deepAll<HTMLElement>("#company-site-button, button.company-site-button, button, a, [role=button]").find((b) => visible(b) && (b.id === "company-site-button" || COMPANY_SITE.test(labelOf(b)))) ?? null;

function findApplyButton(): HTMLElement | null {
  // "Apply on company site" is the plain choice when it is the only one; when both exist Naukri's own (quicker, one click) goes first.
  return findOwnApply() ?? findCompanySite();
}

const isCompanySite = (b: HTMLElement) => b.id === "company-site-button" || COMPANY_SITE.test(labelOf(b));
const alreadyApplied = () => !!document.querySelector("#already-applied, .already-applied") || deepAll<HTMLElement>("button, a, span, div").some((el) => el.children.length === 0 && visible(el) && /^(applied|already applied)$/i.test(clean(el.textContent)));
const sentNotice = () => /successfully applied|you have (successfully )?applied|application (has been )?(sent|submitted)|applied to/i.test(clean(document.body?.innerText).slice(0, 6000)) && !needsSignIn();
const jobClosed = () => /no longer (available|accepting)|job (has )?(expired|closed)|this job is closed|expired/i.test(clean(document.body?.innerText).slice(0, 3000));

/** The short questions panel Naukri shows after Apply on some jobs. */
const questionsPanel = () => deepAll<HTMLElement>("[class*='chatbot' i], [class*='questionnaire' i], [role=dialog], [aria-modal='true']").some((d) => visible(d) && !/login|sign in|register/i.test(d.innerText.slice(0, 200)) && /question|answer|notice period|experience|salary|ctc|type here/i.test(d.innerText));

const describePage = () => {
  const buttons = deepAll<HTMLElement>("button, a[role=button]").filter(visible).map((b) => `${labelOf(b).slice(0, 28)}${b.id ? `#${b.id}` : ""}`).filter(Boolean);
  return `[${location.pathname.slice(0, 50)} | buttons: ${[...new Set(buttons)].slice(0, 8).join(" / ") || "none"}]`;
};

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

/** Presses Apply. Naukri's own is finished on this page; "Apply on company site" opens the employer's site, which the run follows. */
async function handOver(job: JobCard, candidate: AssistCandidate | undefined, button: HTMLElement, send: Send): Promise<Result> {
  const label = `${job.title}${job.company ? ` at ${job.company}` : ""}`;
  const toCompany = isCompanySite(button);
  await say(send, `${label}: clicking "${labelOf(button).slice(0, 30)}"`);
  const fromLink = toCompany ? linkBehind(button) : undefined;
  const announced = await send<{ ok: boolean; seq: number }>({ type: "liApplyExternal", url: fromLink, company: job.company });
  if (fromLink) return { outcome: "EXTERNAL" };

  const before = location.href;
  const opened = await captureOpen(() => press(button), 5_000);
  if (opened && toCompany) {
    await send({ type: "liApplyOpen", url: opened });
    return { outcome: "EXTERNAL" };
  }
  if (toCompany) {
    if (location.href !== before && !isNaukriHost(location.hostname)) return { outcome: "EXTERNAL" };
    if (((await send<{ count: number }>({ type: "liApplyExtCount" }))?.count ?? 0) > 0) return { outcome: "EXTERNAL" };
  }

  // Naukri's own apply, finished on this page: sent by the click, or a questions panel came up.
  const seq = announced?.seq;
  const done = await waitFor(() => (sentNotice() || alreadyApplied() ? "sent" : questionsPanel() ? "form" : null), 12_000);
  if (done === "sent") {
    await send({ type: "liApplyResult", seq, kind: "job", outcome: "APPLIED", reason: "Sent with Naukri's own apply", pageUrl: location.href });
    return { outcome: "EXTERNAL" };
  }
  if (done === "form" && candidate && seq !== undefined) {
    await driveTask({ kind: "external", seq, job, candidate }, send);
    return { outcome: "EXTERNAL" };
  }
  await send({ type: "liApplyResult", seq, kind: "job", outcome: "FAILED", reason: `The Apply button did not lead anywhere ${describePage()}` });
  return { outcome: "EXTERNAL" };
}

async function applyOnNaukri(job: JobCard, candidate: AssistCandidate | undefined, send: Send): Promise<Result> {
  const fail = (reason: string) => ({ outcome: "FAILED" as const, reason });
  await say(send, `opening ${job.title}${job.company ? ` at ${job.company}` : ""}`);
  if (!(await clearChallenge(send))) return fail("Verification was not completed in time");
  if (!(await ensureSignedIn(send))) return fail("Naukri was not signed in");
  await sleep(1_500);

  const button = await waitFor(findApplyButton, 15_000);
  if (!button) {
    if (needsSignIn() && !(await ensureSignedIn(send))) return fail("Naukri was not signed in");
    if (alreadyApplied()) return { outcome: "SKIPPED", reason: "Already applied" };
    if (jobClosed()) return { outcome: "SKIPPED", reason: "The job is closed" };
    return { outcome: "SKIPPED", reason: `No Apply button on this job ${describePage()}` };
  }
  return handOver(job, candidate, button, send);
}

/** A Naukri tab that is not the run's own job page (a redirect page): carry on to the employer's site. */
async function leaveNaukri(task: { seq: number }, send: Send) {
  await say(send, "Naukri: heading to the company's site", true);
  const here = location.href;
  await sleep(4_000);
  if (!isNaukriHost(location.hostname) || location.href !== here) return;

  const outward = deepAll<HTMLAnchorElement>("a[href]").filter((a) => /^https?:/i.test(a.href) && !isNaukriHost(new URL(a.href).hostname) && visible(a));
  const preferred = outward.find((a) => /apply|continue|company|employer|go to|visit/i.test(clean(a.textContent))) ?? outward[0];
  if (preferred) {
    location.assign(preferred.href);
    return;
  }
  const site = findCompanySite();
  if (site) {
    const target = linkBehind(site) ?? (await captureOpen(() => press(site), 5_000));
    if (target) {
      location.assign(target);
      return;
    }
    await sleep(3_000);
    if (!isNaukriHost(location.hostname) || location.href !== here) return;
  }
  await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: `Naukri's page did not lead to the company's site. It said: "${clean(document.body?.innerText).slice(0, 120)}" ${describePage()}` });
}

/** Content-script entry: if this tab is a Naukri run's tab, do the task for this page and report back. */
export async function runNaukriApplyIfAsked(send: Send) {
  if (window !== window.top || !isNaukriHost(location.hostname)) return;
  const task = await send<Task | null>({ type: "liApplyTask" });
  if (!task?.kind) return;

  if (task.kind === "external") {
    if (!task.own) return void (await leaveNaukri(task, send));
    // The run's own job page after the Apply click: a questions panel is filled; if the page was reloaded before the click went
    // through, Apply is clicked again.
    const tabs = async () => (await send<{ count: number }>({ type: "liApplyExtCount" }))?.count ?? 0;
    await say(send, "waiting for the application", true);
    for (let attempt = 0; attempt < 3 && task.job; attempt++) {
      await sleep(4_000);
      if ((await tabs()) > 0) return;
      if (sentNotice() || alreadyApplied()) return void (await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "APPLIED", reason: "Sent with Naukri's own apply", pageUrl: location.href }));
      if (questionsPanel() && task.candidate) return void (await driveTask({ kind: "external", seq: task.seq, job: task.job, candidate: task.candidate }, send));
      if (!(await ensureSignedIn(send))) return;
      const button = findApplyButton();
      if (!button) continue;
      const r = await handOver(task.job, task.candidate, button, send);
      if (r.outcome !== "EXTERNAL") return void (await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r }));
      return;
    }
    return;
  }

  await say(send, task.kind === "search" ? "reading Naukri's search results" : `Naukri: ${task.job?.title ?? "job"}`, true);
  try {
    if (!(await clearChallenge(send))) throw new Error("Verification was not completed in time");
    if (task.kind === "search") {
      await send({ type: "liApplyResult", seq: task.seq, kind: "search", jobs: await readSearchResults(send) });
    } else if (task.job) {
      for (let left = Math.round((task.delayMs ?? 0) / 1000); left > 0; left--) {
        await say(send, `next application in ${left}s: ${task.job.title}`, true);
        await sleep(1_000);
      }
      const r = await applyOnNaukri(task.job, task.candidate, send);
      if (r.outcome !== "EXTERNAL") await send({ type: "liApplyResult", seq: task.seq, kind: "job", ...r });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read Naukri";
    await say(send, `problem: ${message}`);
    if (task.kind === "job") await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: message });
    else await send({ type: "liApplyResult", seq: task.seq, kind: task.kind, error: message });
  }
}
