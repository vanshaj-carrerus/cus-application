import { attachResumeToUploadStep, fillBasics, runQuestions, shadowOf, standingAnswer, type AnswerBackend, type AssistCandidate, type JobInfo } from "../../lib/automation/formEngine";
import { ASSIST_VERSION, MAX_JOBS_PER_SEARCH, type ApplyOutcome, type JobCard } from "./linkedin-shared";

/**
 * Applies to LinkedIn Easy Apply jobs from the candidate's own signed-in browser, one job per page load, only while
 * the background worker says this tab belongs to a Start run. Each step of the form is filled by the same engine the
 * rest of CUS Assist uses: the candidate's profile for the basics, saved answers then the AI for the questions, and the
 * candidate's own resume file when the form asks for one. A required answer is never guessed.
 *
 * Verification is a human step: when LinkedIn shows a CAPTCHA, a security check or a sign-in code, the run pauses on
 * that page, tells the portal, and carries on once the person has completed it. Nothing here tries to get past one.
 *
 * LinkedIn renders the Easy Apply window inside a shadow root, so every lookup here goes through deepAll.
 */

export type Send = <T = unknown>(message: Record<string, unknown>) => Promise<T | null>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
export const HUMAN_WAIT_MS = 10 * 60_000;

/** querySelectorAll that also looks inside every open shadow root. */
export function deepAll<T extends Element>(selector: string, root: ParentNode = document): T[] {
  const found: T[] = Array.from(root.querySelectorAll<T>(selector));
  for (const host of Array.from(root.querySelectorAll("*"))) {
    const shadow = shadowOf(host as HTMLElement);
    if (shadow) found.push(...deepAll<T>(selector, shadow));
  }
  return found;
}

export async function waitFor<T>(find: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = find();
    if (found) return found;
    await sleep(300);
  }
  return null;
}

/* ── the application window ───────────────────────────────────────────── */

export const labelOf = (b: Element) => `${b.getAttribute("aria-label") ?? ""} ${clean(b.textContent)}`.toLowerCase();
const TITLE = /^apply to\s+\S/i;
const ACTION_LABEL =/submit application|review (your )?application|continue to next step|^\s*(next|review|continue)\s*$/;
const dialogs = () => deepAll<HTMLElement>('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal').filter(visible);

/** The Easy Apply window: the open dialog titled "Apply to ...", or failing that the one with Next / Review / Submit in it. */
function findModal(): HTMLElement | null {
  // By what is on screen, not by LinkedIn's markup: the heading "Apply to <company>", then the nearest container around it
  // that holds a Next / Review / Submit button. That is the window on top, whatever it is built from.
  const headings = deepAll<HTMLElement>("h1, h2, h3, h4, [role=heading], div, span, p").filter((el) => el.children.length <= 1 && visible(el) && TITLE.test(clean(el.textContent)) && clean(el.textContent).length < 140);
  for (const heading of headings) {
    let node: HTMLElement | null = heading;
    for (let i = 0; i < 14 && node; i++) {
      if (deepAll<HTMLElement>("button", node).some((b) => visible(b) && ACTION_LABEL.test(labelOf(b)))) return node;
      const root = node.getRootNode();
      node = node.parentElement ?? (root instanceof ShadowRoot ? (root.host as HTMLElement) : null);
    }
  }
  const all = dialogs();
  return all.find((d) => TITLE.test(clean(d.innerText))) ?? all.find((d) => deepAll("button", d).some((b) => ACTION_LABEL.test(labelOf(b)))) ?? null;
}

/** What is on screen when the window can't be found, so the failure says something. */
function describeScreen(): string {
  const dialogsSeen = deepAll<HTMLElement>('[role="dialog"], dialog, .artdeco-modal').filter(visible).map((d) => clean(d.innerText).slice(0, 50));
  const apply = deepAll<HTMLElement>("h1, h2, h3, [role=heading], div, span").filter((el) => el.children.length <= 1 && visible(el) && /apply to/i.test(el.textContent ?? "")).slice(0, 3).map((el) => clean(el.textContent).slice(0, 40));
  return `dialogs: ${dialogsSeen.join(" | ") || "none"}; "Apply to" text: ${apply.join(" | ") || "none"}`;
}

/** Everything the person could read right now, including inside the shadow-root window. */
const pageText = () => `${dialogs().map((d) => d.innerText).join("\n")}\n${document.body?.innerText ?? ""}`;

/* ── verification: pause for the person ───────────────────────────────── */

const CHALLENGE_TEXT = /security verification|quick security check|verify (that )?you('| a)re (a )?human|i'?m not a robot|we sent (you )?a (verification )?code|enter the (verification )?code|verify your identity/i;

function challengeShown(): boolean {
  if (/^\/(checkpoint|uas)(\/|$)/.test(location.pathname)) return true;
  if (deepAll('iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="arkoselabs" i]').some(visible)) return true;
  // A full-page check has very little text; a job description that happens to say "verify" does not count.
  const dialogText = dialogs().map((d) => d.innerText).join("\n");
  return CHALLENGE_TEXT.test(dialogText) || ((document.body?.innerText.length ?? 0) < 1500 && CHALLENGE_TEXT.test(document.body?.innerText ?? ""));
}

/** Waits (up to 10 minutes) while LinkedIn is asking the person to verify. Returns false if they never did. */
export async function clearChallenge(send: Send): Promise<boolean> {
  if (!challengeShown()) return true;
  await send({ type: "liApplyProgress", state: "PAUSED", message: "LinkedIn is asking for verification. Complete it in the LinkedIn tab and the run will continue by itself." });
  const end = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < end) {
    await sleep(2_000);
    if (!challengeShown()) {
      await send({ type: "liApplyProgress", state: "RUNNING", message: "Continuing…" });
      return true;
    }
  }
  return false;
}

/* ── search results ───────────────────────────────────────────────────── */

/** The company named at the top of a job page. */
export function readCompany(): string | undefined {
  const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]')].find((a) => {
    const t = clean(a.textContent);
    return visible(a) && t.length > 0 && t.length < 80 && !/follow|see all|\bjobs$/i.test(t);
  });
  return link ? clean(link.textContent) : undefined;
}

export async function readSearchResults(): Promise<JobCard[]> {
  await waitFor(() => document.querySelector('a[href*="/jobs/view/"]'), 15_000);
  const found = new Map<string, JobCard>();
  for (let pass = 0; pass < 4 && found.size < MAX_JOBS_PER_SEARCH; pass++) {
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]')) {
      const id = a.href.match(/jobs\/view\/(\d+)/)?.[1];
      if (!id || found.has(id)) continue;
      const card = (a.closest("li") ?? a.parentElement) as HTMLElement | null;
      const text = card?.innerText ?? "";
      // A card reads: title, company, location, then "Viewed", "Easy Apply", "3 hours ago"...
      const lines = text.split("\n").map(clean).filter(Boolean);
      const title = lines[0] || clean(a.textContent);
      const details = lines.slice(1).filter((l) => l !== title && !l.startsWith(title) && !/with verification|^viewed|easy apply|^promoted|\bago$|applicants?|^actively|^\d/i.test(l));
      if (title) found.set(id, { id, title, company: details[0], location: details[1], easy: /easy apply/i.test(text), url: `https://www.linkedin.com/jobs/view/${id}/` });
    }
    // The results list loads more cards as it is scrolled.
    const list = document.querySelector<HTMLElement>(".jobs-search-results-list, .scaffold-layout__list");
    (list ?? document.scrollingElement)?.scrollBy?.(0, 1200);
    await sleep(900);
  }
  return [...found.values()].slice(0, MAX_JOBS_PER_SEARCH);
}

/* ── one Easy Apply ───────────────────────────────────────────────────── */

function findApplyButton(): HTMLElement | null {
  const open = dialogs();
  return deepAll<HTMLElement>("button, a").find((b) => visible(b) && /easy apply/i.test(labelOf(b)) && !open.some((d) => d.contains(b))) ?? null;
}

/** A full click: the page's own handlers listen for the pointer and mouse events a real click produces, not only "click". */
export function press(el: HTMLElement) {
  el.scrollIntoView({ block: "center" });
  const init = { bubbles: true, cancelable: true, composed: true, view: window };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, init) : new MouseEvent(type, init));
  }
}

/** The job's "Apply" button when it is not Easy Apply (it leads to the company's own site). */
function findExternalApply(): HTMLElement | null {
  const open = dialogs();
  return deepAll<HTMLElement>("a, button").find((b) => visible(b) && !open.some((d) => d.contains(b)) && /(^|\s)apply(\s|$)/.test(labelOf(b)) && !/easy apply|filter|saved|applied|alert/.test(labelOf(b))) ?? null;
}

type Action = { kind: "submit" | "review" | "next"; el: HTMLElement; enabled: boolean };

/** Not a way forward: closing, going back, saving or editing something on the step. */
const NOT_FORWARD = /dismiss|close|back|save|discard|cancel|upload|remove|delete|edit|choose|change|add |show more|learn more/;

/** The button that moves the application on: Submit, else Review, else Next (by its label, then by being the step's primary button). */
function findAction(modal: HTMLElement): Action | null {
  const buttons = deepAll<HTMLButtonElement>("button", modal).filter(visible);
  const make = (kind: Action["kind"], el: HTMLButtonElement): Action => ({ kind, el, enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true" });
  const submit = buttons.find((b) => /submit application/.test(labelOf(b)));
  if (submit) return make("submit", submit);
  const review = buttons.find((b) => /review (your )?application|^\s*review\s*$/.test(labelOf(b)));
  if (review) return make("review", review);
  const next = buttons.find((b) => /continue to next step|^\s*(next|continue)\s*$/.test(labelOf(b)));
  if (next) return make("next", next);
  // Different wording: the step's primary button, as long as it is not one of the "other" buttons.
  const primary = buttons.filter((b) => /primary/.test(b.className) && !NOT_FORWARD.test(labelOf(b))).at(-1);
  return primary ? make("next", primary) : null;
}

/**
 * The toggles LinkedIn adds to the last steps ("Set alert for similar jobs as ...", "Mark job as a top choice") always get
 * the same answer: alerts on, top choice off. Done straight on the page, whatever the toggle is built from.
 */
function applyStandingToggles(modal: HTMLElement) {
  for (const control of deepAll<HTMLElement>('input[type="checkbox"], [role="switch"], [role="checkbox"]', modal)) {
    const label = control.id ? deepAll<HTMLElement>(`label[for="${control.id}"]`, modal)[0] : control.closest<HTMLElement>("label");
    const text = clean(control.getAttribute("aria-label") || label?.textContent || control.parentElement?.textContent).slice(0, 200);
    const want = standingAnswer(text);
    if (want === null) continue;
    const on = control instanceof HTMLInputElement ? control.checked : control.getAttribute("aria-checked") === "true";
    if (on !== want) press(label ?? control);
  }
}

/** "1/4 pages" in the window header. */
function pageInfo(modal: HTMLElement): { cur: number; total: number } | null {
  const m = modal.innerText.match(/(\d+)\s*\/\s*(\d+)\s*pages?/i);
  return m ? { cur: Number(m[1]), total: Number(m[2]) } : null;
}

/** The visible fields on the step with what they currently hold, for a message the person can act on. */
function describeFields(modal: HTMLElement): string {
  const fields = deepAll<HTMLInputElement>("input, select, textarea", modal).filter((el) => visible(el) && el.type !== "hidden" && el.type !== "file");
  const out = fields.slice(0, 8).map((el) => {
    const name = clean(el.getAttribute("aria-label") || el.closest("div")?.querySelector("label")?.textContent || el.id).slice(0, 40);
    const value = el instanceof HTMLSelectElement ? clean(el.selectedOptions[0]?.text) : el.value;
    return `${name || "field"}=${value ? clean(value).slice(0, 30) : "(empty)"}`;
  });
  return out.join("; ") || "none";
}

const stepSignature =(modal: HTMLElement) => `${pageInfo(modal)?.cur ?? "?"}|${clean(modal.innerText).slice(0, 300)}`;

const firstError = (root: ParentNode) => clean(deepAll(".artdeco-inline-feedback--error, [role=alert]", root)[0]?.textContent).slice(0, 200) || "no reason shown";
const buttonsIn = (modal: HTMLElement) => deepAll<HTMLElement>("button", modal).filter(visible).map((b) => clean(b.getAttribute("aria-label") || b.textContent).slice(0, 30)).filter(Boolean).join(" / ");

/** Leaves the application window without sending anything. */
async function dismiss() {
  deepAll<HTMLElement>('button[aria-label="Dismiss"], button[data-test-modal-close-btn]').find(visible)?.click();
  await sleep(800);
  deepAll<HTMLElement>("button").find((b) => visible(b) && /^discard$/i.test(clean(b.textContent)))?.click();
  await sleep(500);
}

const sent = () => /application (was )?sent|your application was sent|application submitted/i.test(pageText());

export function answerBackend(send: Send, job: JobInfo): AnswerBackend {
  const ask = <T>(request: Record<string, unknown>) => send<T>({ type: "liApplyAnswers", job, request });
  return {
    async lookupSaved(asked) {
      const r = await ask<{ answers: Array<{ id: string; answer: string; savedId: string }> }>({ action: "lookup", asked });
      return new Map((r?.answers ?? []).map((a) => [a.id, { answer: a.answer, savedId: a.savedId }]));
    },
    async askModel(questions) {
      const r = await ask<{ answers?: Array<{ id: string; answer: string | boolean | string[] | null }>; error?: string }>({ action: "ask", questions });
      if (!r?.answers) throw new Error(r?.error ?? "the portal didn't answer");
      return r.answers;
    },
    async markUsed(savedIds) {
      await ask({ action: "used", savedIds });
    },
    async recordNeeded(questions, askedOn) {
      return (await ask<{ created: number }>({ action: "needed", questions, askedOn }))?.created ?? 0;
    },
  };
}

/** The candidate's own resume file, fetched once and only if a form step asks for one. */
let resumeFile: File | null | undefined;
export async function getResume(send: Send): Promise<File | null> {
  if (resumeFile !== undefined) return resumeFile;
  const r = await send<{ resume?: { name: string; mime: string; base64: string } | null }>({ type: "liApplyResume" });
  resumeFile = r?.resume ? new File([Uint8Array.from(atob(r.resume.base64), (c) => c.charCodeAt(0))], r.resume.name, { type: r.resume.mime }) : null;
  return resumeFile;
}

/**
 * A resume step with nothing chosen yet: a file input waiting for a file, and no resume file name already shown.
 * LinkedIn pre-selects the resume saved on the account; uploading another one on every application would pile up copies.
 */
function wantsResumeUpload(modal: HTMLElement): boolean {
  const empty = deepAll<HTMLInputElement>('input[type="file"]', modal).some((i) => !i.disabled && (i.files?.length ?? 0) === 0);
  const text = modal.innerText;
  return empty && /resume|\bcv\b/i.test(text) && !/\.(pdf|docx?)\b/i.test(text);
}

/** The small status box in the corner: what the bot is doing right now. It also goes to the portal card, so a stall can be seen from either side. */
let statusBox: HTMLElement | null = null;
let lastStatus = "";
export async function say(send: Send, text: string, quiet = false) {
  if (!statusBox) {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647";
    const box = document.createElement("div");
    box.style.cssText = "background:#0f172a;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;max-width:420px;box-shadow:0 4px 16px rgba(0,0,0,.35)";
    host.attachShadow({ mode: "closed" }).append(box);
    document.documentElement.append(host);
    statusBox = box;
  }
  statusBox.textContent = `CUS Assist v${ASSIST_VERSION}: ${text}`;
  if (!quiet && text !== lastStatus) {
    lastStatus = text;
    await send({ type: "liApplyProgress", state: "RUNNING", message: `v${ASSIST_VERSION} · ${text}` });
  }
}

/** Never lets one stage hang the whole run: gives up on it and carries on. */
export function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

const JOB_BUDGET_MS = 6 * 60_000;

export async function applyToJob(job: JobCard, candidate: AssistCandidate, send: Send): Promise<{ outcome: ApplyOutcome | "EXTERNAL"; reason?: string }> {
  const fail = (reason: string) => ({ outcome: "FAILED" as const, reason });
  const info: JobInfo = { title: job.title, company: job.company ?? "" };
  const backend = answerBackend(send, info);
  const label = `${job.title}${job.company ? ` at ${job.company}` : ""}`;
  const startedAt = Date.now();

  await say(send, `opening ${label}`);
  if (!(await clearChallenge(send))) return fail("Verification was not completed in time");
  const apply = await waitFor(findApplyButton, 12_000);
  if (!apply) {
    if (/see application|you applied|applied \d+ (minute|hour|day|week)/i.test(pageText())) return { outcome: "SKIPPED", reason: "Already applied" };
    const outside = findExternalApply();
    if (!outside) return { outcome: "SKIPPED", reason: "No Apply button on this job (it may be closed)" };
    // The application is on the company's own site: hand over to the tab that opens, which fills and submits it there.
    await say(send, `${label}: opening the company's own application site`);
    const href = outside instanceof HTMLAnchorElement && /^https?:/i.test(outside.href) ? outside.href : undefined;
    // A page script cannot open a new tab by clicking (the browser blocks it), so a link is opened by the extension itself.
    await send({ type: "liApplyExternal", url: href, company: readCompany() });
    if (!href) press(outside);
    return { outcome: "EXTERNAL" };
  }
  apply.click();
  // The window is the one headed "Apply to <company>".
  if (!(await waitFor(findModal, 12_000))) return fail(`The application window could not be found on the page (${describeScreen()})`);

  let stuck = 0;
  let lastMissing: string[] = [];
  for (let step = 0; step < 15; step++) {
    await sleep(1_200);
    if (Date.now() - startedAt > JOB_BUDGET_MS) {
      await dismiss();
      return fail(`Took too long on this application (last step: ${lastStatus})`);
    }
    if (!(await clearChallenge(send))) {
      await dismiss();
      return fail("Verification was not completed in time");
    }
    let modal = findModal();
    if (!modal) return sent() ? { outcome: "APPLIED" } : fail("The application window closed unexpectedly");
    const pages = pageInfo(modal);
    const where = pages ? `step ${pages.cur}/${pages.total}` : `step ${step + 1}`;

    // 1. The fixed fields from the candidate's profile.
    await say(send, `${where}: filling the candidate's details`);
    fillBasics(candidate, null);

    // 2. The candidate's own resume, if this step asks for one and none is chosen.
    if (wantsResumeUpload(modal)) {
      await say(send, `${where}: attaching the resume`);
      const file = await within(getResume(send), 30_000);
      if (file && attachResumeToUploadStep(file)) await sleep(2_000);
    }

    // 3. Everything else the step asks: saved answers first, then the AI, from the candidate's profile.
    await say(send, `${where}: answering the questions`);
    const questions = await within(runQuestions(info, undefined, backend), 75_000);
    lastMissing = questions?.requiredMissing ?? [];
    // A required question only the candidate can answer: it is saved on their profile, so leave this one and go on.
    const blocking = (questions?.requiredMissing ?? []).filter((l) => questions?.needsPerson.includes(l));
    if (blocking.length > 0) {
      await dismiss();
      return fail(`Needs the candidate's answer: ${blocking.slice(0, 3).join("; ")}. Saved on their profile.`);
    }

    applyStandingToggles(modal);

    // 4. Forward. The form is re-read first because answering can re-draw the window.
    modal = findModal();
    if (!modal) return fail("The application window closed unexpectedly");
    let action = findAction(modal);
    if (action && !action.enabled) {
      await waitFor(() => (action = findAction(modal!)) && action.enabled, 6_000);
    }
    if (!action) {
      const buttons = buttonsIn(modal);
      await dismiss();
      return fail(`Could not find the Next or Submit button (buttons seen: ${buttons || "none"})`);
    }

    if (action.kind === "submit") {
      await say(send, `${where}: submitting`);
      // "Follow company" is ticked by default and is not part of applying.
      const follow = deepAll<HTMLInputElement>("input#follow-company-checkbox", modal)[0];
      if (follow?.checked) deepAll<HTMLElement>('label[for="follow-company-checkbox"]', modal)[0]?.click();
      press(action.el);
      if (await waitFor(sent, 15_000)) {
        await sleep(800);
        deepAll<HTMLElement>('button[aria-label="Dismiss"]').find(visible)?.click();
        return { outcome: "APPLIED" };
      }
      const why = firstError(modal);
      await dismiss();
      return fail(`LinkedIn did not confirm the submission: ${why}`);
    }

    await say(send, `${where}: clicking ${action.kind === "review" ? "Review" : "Next"}`);
    const before = stepSignature(modal);
    press(action.el);
    const moved = await waitFor(() => {
      const m = findModal();
      return !m || stepSignature(m) !== before;
    }, 8_000);
    if (moved) {
      stuck = 0;
      continue;
    }
    // Still on the same step: LinkedIn is asking for something that was not filled in.
    stuck += 1;
    if (stuck >= 2) {
      // Never walk away from a half-done application. Say exactly what is wrong, wait for the person to sort it
      // out in this tab, and carry on from wherever they leave it.
      const detail = `${where} did not move on after clicking ${action.kind === "review" ? "Review" : "Next"}. LinkedIn says: ${firstError(modal)}.${lastMissing.length ? ` Needs an answer from the candidate: ${lastMissing.slice(0, 3).join("; ")}.` : ""} Fields: ${describeFields(modal)}`;
      await send({ type: "liApplyProgress", state: "PAUSED", message: `Needs you: ${detail} Fix it in the LinkedIn tab (or click Next yourself) and the run continues.`.slice(0, 290) });
      const resumed = await waitFor(() => {
        const m = findModal();
        return !m || stepSignature(m) !== before;
      }, HUMAN_WAIT_MS);
      await send({ type: "liApplyProgress", state: "RUNNING", message: "Continuing…" });
      if (!resumed) {
        await dismiss();
        return fail(detail);
      }
      stuck = 0;
    }
  }
  await dismiss();
  return fail("The application had too many steps");
}

/** Content-script entry: if this tab is the Start run's tab, do the task for this page and report back. */
export async function runLinkedInApplyIfAsked(send: Send) {
  if (window !== window.top || !/(^|\.)linkedin\.com$/.test(location.hostname)) return;
  const task = await send<{ kind: "search" | "job" | "external"; seq: number; job?: JobCard; candidate?: AssistCandidate; delayMs?: number } | null>({ type: "liApplyTask" });
  if (!task?.kind || task.kind === "external") return;
  try {
    if (!(await clearChallenge(send))) throw new Error("Verification was not completed in time");
    if (task.kind === "search") {
      await send({ type: "liApplyResult", seq: task.seq, kind: "search", jobs: await readSearchResults() });
    } else if (task.job && task.candidate) {
      // Applications are paced; the box counts down so a wait never looks like a stall.
      for (let left = Math.round((task.delayMs ?? 0) / 1000); left > 0; left--) {
        await say(send, `next application in ${left}s: ${task.job.title}`, true);
        await sleep(1_000);
      }
      const company = readCompany();
      const r = await applyToJob(task.job, task.candidate, send);
      if (r.outcome !== "EXTERNAL") await send({ type: "liApplyResult", seq: task.seq, kind: "job", company, ...r });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read LinkedIn";
    await say(send, `problem: ${message}`);
    // A problem on one job is that job's failure; the run goes on to the next one. Only a failed search ends the run.
    if (task.kind === "job") await send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome: "FAILED", reason: message });
    else await send({ type: "liApplyResult", seq: task.seq, kind: task.kind, error: message });
  }
}
