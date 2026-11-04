import { fillBasics, hasVisibleForm, runQuestions, submissionEvidence, type AssistCandidate, type JobInfo } from "../../lib/automation/formEngine";
import { isPortalHost, type JobCard } from "./linkedin-shared";
import { HUMAN_WAIT_MS, answerBackend, clean, deepAll, getResume, press, say, sleep, visible, waitFor, within, type Send } from "./linkedin-apply";

/**
 * The other half of a Start run: a job whose Apply button leads to the company's own site (Greenhouse, Lever, Workday,
 * their own careers page...). The tab LinkedIn opened runs the same loop as Easy Apply: fill what the page asks from
 * the candidate's profile, attach the resume, let the AI answer the questions, press Next / Continue until the Submit
 * button, press it, and stop when the site shows its "application received" page.
 *
 * Things a person has to do stay with the person: signing in or creating an account on the company's site, a CAPTCHA
 * or verification, and legal "I certify" boxes. The run waits on that page and carries on once it is done.
 */

export interface ExternalTask {
  kind: "external";
  seq: number;
  job: JobCard;
  candidate: AssistCandidate;
}

const TASK_BUDGET_MS = 8 * 60_000;
/** How long a run keeps trying on its own on a stuck page before it leaves that application (kept as a draft that can be retried) and goes to the next. */
const STUCK_MS = 30_000;

type Outcome = "APPLIED" | "FAILED" | "NEEDS_HUMAN";

const labelText = (el: Element) => {
  const input = el as HTMLInputElement;
  const own = el.tagName === "INPUT" && /^(submit|button)$/.test(input.type) ? input.value : "";
  return clean(own || el.getAttribute("aria-label") || el.textContent).toLowerCase().replace(/[›»→>]+$/, "").trim();
};

const SUBMIT = /^(submit( your)?( application)?|send( your)?( application)?|apply( now| here| today| for (this )?(job|position|role))?|submit (form|details|now)|finish|complete( application)?|confirm|review and submit)$/;
const NEXT = /^(next|continue|save (and|&) continue|continue to .+|proceed|next step|go to next step)$/;
/** The button or link on a job page that opens the application: "Apply", "Apply now", "Apply for this job", "Start application"... */
const ENTRY = /^(apply\b.{0,30}|start( your)? application|i'?m interested|submit (an|your) application)$/;
const NOT_ENTRY = /applied|applicant|application (status|form help)|filter|alert|saved|how to apply|sign in|log in/;

/** Employer pages use plain links, sticky headers and custom buttons for Apply, so everything clickable is looked at. */
function findEntry(): HTMLElement | null {
  const all = deepAll<HTMLElement>('a[href], button, input[type="submit"], input[type="button"], [role="button"], [role="link"]').filter((el) => visible(el) && isEnabled(el));
  const matches = all.filter((el) => {
    const text = labelText(el);
    return text.length > 0 && text.length < 45 && ENTRY.test(text) && !NOT_ENTRY.test(text);
  });
  // Where the page puts it matters less than which is the main one: the first in the page body, else the first anywhere.
  return matches.find((el) => !el.closest("nav, footer, [role=navigation]")) ?? matches[0] ?? null;
}

/** A cookie / consent banner can sit on top of the Apply button and swallow the click. */
function dismissCookieBanner(): boolean {
  const accept = deepAll<HTMLElement>('button, a[role="button"], [role="button"]').find(
    (b) => visible(b) && /^(accept( all)?( cookies)?|allow all( cookies)?|i accept|i agree|agree|got it|ok|okay)$/.test(labelText(b)) && !!b.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [role="dialog"]')
  );
  if (!accept) return false;
  press(accept);
  return true;
}

const OVERLAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="pop-up" i], [class*="overlay" i], [class*="lightbox" i], [id*="modal" i], [id*="popup" i]';
const CLOSE_TEXT = /^(×|✕|✖|x|close|dismiss|no,? thanks|no thank you|skip|skip for now|not now|maybe later|remind me later|continue without .+)$/;
const CLOSE_HINT = /(close|dismiss)/i;

/** The "Start your application" choice (Workday and similar): Autofill with Resume / Apply Manually / Use My Last Application. */
const AUTOFILL = /^autofill with (my )?(resume|cv)$/;
const findAutofill = () => clickables(document).find((b) => AUTOFILL.test(labelText(b)));

/**
 * Closes a pop-up that sits over the application (a promo, a newsletter or chat offer, a product tour) by its own close / skip /
 * no-thanks control. Never touches the application's own window (anything holding a form to fill), and never agrees to anything.
 */
function dismissPopup(): boolean {
  for (const box of deepAll<HTMLElement>(OVERLAY).filter(visible)) {
    if (clickables(box).some((b) => AUTOFILL.test(labelText(b)))) continue; // a choice the run makes, not a pop-up to close
    const r = box.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const fields = deepAll<HTMLInputElement>("input, select, textarea", box).filter((f) => visible(f) && !/^(hidden|checkbox|radio)$/.test(f.type));
    if (fields.length > 0 || deepAll('input[type="file"]', box).length > 0) continue; // the application's own window
    const close = deepAll<HTMLElement>('button, a, [role="button"], span, div, i, svg', box).find((el) => {
      if (!visible(el)) return false;
      const text = labelText(el);
      const hint = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${typeof el.className === "string" ? el.className : ""}`;
      const small = el.getBoundingClientRect().width < 220;
      return small && (CLOSE_TEXT.test(text) || (CLOSE_HINT.test(hint) && text.length < 12));
    });
    if (close) {
      press((close.closest('button, a, [role="button"]') as HTMLElement | null) ?? close);
      return true;
    }
  }
  return false;
}

/** Opens the entry: a link that would open a new tab is followed in this tab instead, so the driver stays with the application. */
function openEntry(entry: HTMLElement) {
  const link = entry.closest<HTMLAnchorElement>("a[href]");
  if (link && /^https?:/i.test(link.href) && link.target === "_blank") location.assign(link.href);
  else press(entry);
}

const CLICKABLE = 'button, input[type="submit"], input[type="button"], a[href], [role="button"], [onclick], [tabindex="0"], [class*="btn" i], [class*="button" i], [class*="submit" i]';

/** Everything on the page that can be pressed. Custom sites make Apply / Submit out of links, divs and spans, not only <button>. */
const clickables = (scope: ParentNode) => {
  const found = deepAll<HTMLElement>(CLICKABLE, scope).filter((el) => visible(el) && !el.closest("header, nav, footer, [role=banner], [role=navigation]"));
  // A last look at plain elements that only behave like buttons (a pointer cursor and a short label of their own).
  const plain = deepAll<HTMLElement>("div, span, p, li", scope).filter(
    (el) => el.children.length === 0 && !found.includes(el) && visible(el) && clean(el.textContent).length < 30 && getComputedStyle(el).cursor === "pointer" && !el.closest("header, nav, footer, [role=banner], [role=navigation]")
  );
  return [...found, ...plain];
};
const isEnabled = (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";

/** The visible fields on the page, as a number the page can be compared by. */
const fieldCount = () => deepAll<HTMLInputElement>("input, select, textarea").filter((el) => visible(el) && el.type !== "hidden").length;
const signature = () => `${location.href}|${fieldCount()}|${clean(document.body?.innerText).slice(0, 400)}`;
const passwordWall = () => deepAll<HTMLInputElement>('input[type="password"]').some(visible);
const emptyFileInput = () => deepAll<HTMLInputElement>('input[type="file"]').some((i) => !i.disabled && (i.files?.length ?? 0) === 0);

/* A CAPTCHA the visitor has to tick. Nothing here solves or clicks it: a person ticks it, and the run waits CAPTCHA_WAIT_MS for that before it goes to the next job. */
const CAPTCHA_WAIT_MS = 30_000;
const captchaWidget = () =>
  deepAll<HTMLElement>('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], iframe[title*="captcha" i], .g-recaptcha, .h-captcha, .cf-turnstile').some(
    (el) => visible(el) && !/size=invisible/i.test(el.getAttribute("src") ?? "") && !el.closest(".grecaptcha-badge")
  );
const captchaSolved = () => deepAll<HTMLTextAreaElement | HTMLInputElement>('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]').some((el) => el.value.trim().length > 0);
/** A whole page that is only a check ("Just a moment", "verify you are human"), as opposed to a widget on a form. */
const fullPageCheck = () => (document.body?.innerText.length ?? 0) < 1200 && /verify (that )?you('| a)re (a )?human|just a moment|checking your browser|i'?m not a robot/i.test(document.body?.innerText ?? "");

/** Submit if the page has it, else the button that moves to the next step. */
function findForward(): { kind: "submit" | "next"; el: HTMLElement } | null {
  const field = deepAll<HTMLInputElement>("input:not([type=hidden]), select, textarea").find(visible);
  const inForm = field?.closest("form") ? clickables(field.closest("form")!) : [];
  for (const scope of [inForm, clickables(document)]) {
    const submit = scope.find((b) => SUBMIT.test(labelText(b)));
    if (submit) return { kind: "submit", el: submit };
    const next = scope.find((b) => NEXT.test(labelText(b)));
    if (next) return { kind: "next", el: next };
  }
  return null;
}

/** Tells the portal a person is needed, then waits (ten minutes) until `done` is true. Used where only the candidate can act (Glassdoor sign-in). */
export async function waitForPerson(send: Send, message: string, done: () => boolean, ms = HUMAN_WAIT_MS): Promise<boolean> {
  await send({ type: "liApplyProgress", state: "PAUSED", message: `Needs you: ${message}`.slice(0, 290) });
  await say(send, `waiting for you: ${message}`, true);
  const ok = await waitFor(done, ms);
  await send({ type: "liApplyProgress", state: "RUNNING", message: "Continuing…" });
  return !!ok;
}

async function drive(task: ExternalTask, send: Send, report: (outcome: Outcome, reason?: string) => Promise<unknown>) {
  const { job, candidate } = task;
  const info: JobInfo = { title: job.title, company: job.company ?? "" };
  const backend = answerBackend(send, info);
  const host = location.hostname;
  const startedAt = Date.now();
  let stalledSince = 0;
  let idle = 0;
  let submitClicked = false;

  await say(send, `${job.title}: on ${host}`);
  await sleep(2_000); // let the page settle

  for (let i = 0; i < 40; i++) {
    if (Date.now() - startedAt > TASK_BUDGET_MS) return report("FAILED", `Took too long on ${host}`);
    if (fullPageCheck() && !(await waitForPerson(send, `${host} is showing a human check. Tick it within 30 seconds and the run continues.`, () => !fullPageCheck(), CAPTCHA_WAIT_MS))) {
      return report("NEEDS_HUMAN", `${host} showed a human check (CAPTCHA) that was not completed in 30 seconds`);
    }

    const evidence = submissionEvidence();
    if (evidence) {
      await say(send, "application sent");
      return report("APPLIED", `Submitted on ${host} (${evidence})`);
    }

    // Always the resume route: the site reads the candidate's resume, then the fields it missed are filled from the profile below.
    const autofill = findAutofill();
    if (autofill) {
      await say(send, `${host}: choosing "Autofill with Resume"`);
      const before = signature();
      press(autofill);
      await waitFor(() => signature() !== before, 10_000);
      await sleep(1_500);
      continue;
    }

    for (let k = 0; k < 3 && dismissPopup(); k++) {
      await say(send, `${host}: closed a pop-up`, true);
      await sleep(800);
    }

    // An account wall: the candidate's own login or a new account is theirs to make.
    if (passwordWall()) {
      await say(send, `${host}: asks to sign in, trying for 30s`, true);
      if (!(await waitFor(() => !passwordWall() || !!submissionEvidence(), STUCK_MS))) return report("NEEDS_HUMAN", `${host} needs the candidate to sign in or create an account`);
      await sleep(1_500);
      continue;
    }

    // A landing page: find the way into the application form.
    if (!hasVisibleForm()) {
      if (dismissCookieBanner()) await sleep(800);
      const entry = findEntry();
      if (entry) {
        await say(send, `${host}: clicking "${labelText(entry).slice(0, 30)}"`);
        const before = signature();
        openEntry(entry);
        // Stays on this page until it changes (a form, a login, a new page). A click that changed nothing is tried again on the next pass.
        if (!(await waitFor(() => signature() !== before, 10_000))) idle += 1;
        if (idle >= 4) return report("FAILED", `The Apply button on ${host} did not open the application`);
        continue;
      }
      idle += 1;
      if (idle >= 6) {
        const seen = clickables(document).map((b) => labelText(b).slice(0, 24)).filter(Boolean).slice(0, 8).join(" / ");
        return report("FAILED", `No Apply button or application form found on ${host} [buttons: ${seen || "none"}]`);
      }
      await sleep(2_500);
      continue;
    }
    idle = 0;

    await say(send, `${host}: filling the form`);
    const resume = emptyFileInput() ? await within(getResume(send), 30_000) : null;
    fillBasics(candidate, resume);
    if (resume) await sleep(1_500);

    await say(send, `${host}: answering the questions`);
    const answers = await within(runQuestions(info, undefined, backend), 75_000);
    // A required question only the candidate can answer is saved on their profile; leave this job and go on.
    const blocking = (answers?.requiredMissing ?? []).filter((l) => answers?.needsPerson.includes(l));
    if (blocking.length > 0) return report("NEEDS_HUMAN", `Needs the candidate's answer: ${blocking.slice(0, 3).join("; ")}. Saved on their profile.`);

    let action = findForward();
    if (action && !isEnabled(action.el)) await waitFor(() => (action = findForward()) && isEnabled(action.el), 5_000);
    if (!action) {
      stalledSince ||= Date.now();
      if (Date.now() - stalledSince > STUCK_MS) return report("NEEDS_HUMAN", `No Next or Submit button found on ${host}`);
      await say(send, `${host}: looking for the next step`, true);
      await sleep(2_000);
      continue;
    }

    // Submit is pressed once. If the site gave no confirmation, it is not pressed again (that would send the application twice).
    if (action.kind === "submit" && submitClicked) {
      const sent = await waitFor(() => submissionEvidence(), STUCK_MS);
      if (sent) return report("APPLIED", `Submitted on ${host} (${sent})`);
      return report("NEEDS_HUMAN", `Pressed Submit on ${host} but saw no confirmation. Check whether it was sent`);
    }

    // The form is filled. If it has a tick-box CAPTCHA, wait 30 seconds for the candidate to tick it, then submit; else go on to the next job.
    if (action.kind === "submit" && captchaWidget() && !captchaSolved()) {
      const ticked = await waitForPerson(send, `${host}: the form is filled. Tick "I'm not a robot" within 30 seconds and it is submitted.`, captchaSolved, CAPTCHA_WAIT_MS);
      if (!ticked) return report("NEEDS_HUMAN", `${host}: the CAPTCHA was not ticked within 30 seconds, so the application was left`);
    }

    await say(send, `${host}: clicking ${action.kind === "submit" ? "Submit" : "Next"}`);
    const before = signature();
    press(action.el);
    if (action.kind === "submit") {
      submitClicked = true;
      const sent = await waitFor(() => submissionEvidence(), 15_000);
      if (sent) {
        await say(send, "application sent");
        return report("APPLIED", `Submitted on ${host} (${sent})`);
      }
    }
    if (await waitFor(() => signature() !== before, 8_000)) {
      stalledSince = 0;
      continue;
    }
    // The step did not move: keep trying on its own (refill, press again) for 30 seconds, then leave this application.
    stalledSince ||= Date.now();
    if (Date.now() - stalledSince > STUCK_MS || submitClicked) {
      const missing = (answers?.requiredMissing ?? []).slice(0, 3).join("; ");
      return report("NEEDS_HUMAN", `${host} did not accept this step${missing ? ` (needs: ${missing})` : ""}`);
    }
  }
  return report("FAILED", `The application on ${host} had too many steps`);
}

/** Drives the application in this tab (a company's site, or Indeed's own form) and reports how it ended. */
export async function driveTask(task: ExternalTask, send: Send) {
  const report = (outcome: Outcome, reason?: string) => send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome, reason, pageUrl: outcome === "APPLIED" ? location.href : undefined });
  try {
    await drive(task, send, report);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not complete the application";
    await say(send, `problem: ${message}`);
    await report("FAILED", message);
  }
}

/** Content-script entry: if this tab belongs to a Start run that is working on a company site, do this page and report back. */
export async function runExternalApplyIfAsked(send: Send) {
  if (window !== window.top || isPortalHost(location.hostname)) return;
  const task = await send<ExternalTask | null>({ type: "liApplyTask" });
  if (task?.kind !== "external" || !task.job || !task.candidate) return;
  await driveTask(task, send);
}
