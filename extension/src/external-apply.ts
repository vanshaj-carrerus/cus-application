import { fillBasics, hasVisibleForm, runQuestions, submissionEvidence, type AssistCandidate, type JobInfo } from "../../lib/automation/formEngine";
import { isPortalHost, type JobCard } from "./linkedin-shared";
import { HUMAN_WAIT_MS, answerBackend, clean, clearChallenge, deepAll, getResume, press, say, sleep, visible, waitFor, within, type Send } from "./linkedin-apply";

/**
 * The other half of a Start run: a job whose Apply button leads to the company's own site (Greenhouse, Lever, Workday,
 * their own careers page...). The tab LinkedIn opened runs the same loop as Easy Apply: fill what the page asks from
 * the candidate's profile, attach the resume, let the AI answer the questions, press Next / Continue until the Submit
 * button, press it, and stop when the site shows its "application received" page.
 *
 * Things a person has to do stay with the person: signing in or creating an account on the company's site, a CAPTCHA
 * or verification, and legal "I certify" boxes. The run waits on that page and carries on once it is done.
 */

interface ExternalTask {
  kind: "external";
  seq: number;
  job: JobCard;
  candidate: AssistCandidate;
}

const TASK_BUDGET_MS = 8 * 60_000;

const labelText = (el: Element) => {
  const input = el as HTMLInputElement;
  const own = el.tagName === "INPUT" && /^(submit|button)$/.test(input.type) ? input.value : "";
  return clean(own || el.getAttribute("aria-label") || el.textContent).toLowerCase().replace(/[›»→>]+$/, "").trim();
};

const SUBMIT = /^(submit( your)?( application)?|send( your)?( application)?|apply( now)?|finish|complete( application)?|confirm|review and submit)$/;
const NEXT = /^(next|continue|save (and|&) continue|continue to .+|proceed|next step|go to next step)$/;
const ENTRY = /^(apply( now| for this job| for this position| to this job| online)?|start( your)? application|i'?m interested)$/;

const clickables = (scope: ParentNode) =>
  deepAll<HTMLElement>('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"], a.button, a.btn', scope).filter(
    (el) => visible(el) && !el.closest("header, nav, footer, [role=banner], [role=navigation]")
  );
const isEnabled = (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";

/** The visible fields on the page, as a number the page can be compared by. */
const fieldCount = () => deepAll<HTMLInputElement>("input, select, textarea").filter((el) => visible(el) && el.type !== "hidden").length;
const signature = () => `${location.href}|${fieldCount()}|${clean(document.body?.innerText).slice(0, 400)}`;
const passwordWall = () => deepAll<HTMLInputElement>('input[type="password"]').some(visible);
const emptyFileInput = () => deepAll<HTMLInputElement>('input[type="file"]').some((i) => !i.disabled && (i.files?.length ?? 0) === 0);

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

/** Tells the portal a person is needed, then waits (up to ten minutes) until `done` is true. */
export async function waitForPerson(send: Send, message: string, done: () => boolean): Promise<boolean> {
  await send({ type: "liApplyProgress", state: "PAUSED", message: `Needs you: ${message}`.slice(0, 290) });
  await say(send, `waiting for you: ${message}`, true);
  const ok = await waitFor(done, HUMAN_WAIT_MS);
  await send({ type: "liApplyProgress", state: "RUNNING", message: "Continuing…" });
  return !!ok;
}

async function drive(task: ExternalTask, send: Send, report: (outcome: "APPLIED" | "FAILED", reason?: string) => Promise<unknown>) {
  const { job, candidate } = task;
  const info: JobInfo = { title: job.title, company: job.company ?? "" };
  const backend = answerBackend(send, info);
  const host = location.hostname;
  const startedAt = Date.now();
  let stuck = 0;
  let idle = 0;

  await say(send, `${job.title}: on ${host}`);
  await sleep(2_000); // let the page settle

  for (let i = 0; i < 40; i++) {
    if (Date.now() - startedAt > TASK_BUDGET_MS) return report("FAILED", `Took too long on ${host}`);
    if (!(await clearChallenge(send))) return report("FAILED", "Verification was not completed in time");

    const evidence = submissionEvidence();
    if (evidence) {
      await say(send, "application sent");
      return report("APPLIED", `Submitted on ${host} (${evidence})`);
    }

    // An account wall: the candidate's own login or a new account is theirs to make.
    if (passwordWall()) {
      const cleared = await waitForPerson(send, `${host} asks the candidate to sign in or create an account. Do it in this tab and the run continues.`, () => !passwordWall());
      if (!cleared) return report("FAILED", `${host} needs the candidate to sign in or create an account`);
      await sleep(1_500);
      continue;
    }

    // A landing page: find the way into the application form.
    if (!hasVisibleForm()) {
      const entry = clickables(document).find((b) => ENTRY.test(labelText(b)));
      if (entry) {
        await say(send, `${host}: opening the application form`);
        const before = signature();
        press(entry);
        await waitFor(() => signature() !== before, 8_000);
        continue;
      }
      idle += 1;
      if (idle >= 3) return report("FAILED", `No application form found on ${host}`);
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
    if (blocking.length > 0) return report("FAILED", `Needs the candidate's answer: ${blocking.slice(0, 3).join("; ")}. Saved on their profile.`);

    let action = findForward();
    if (action && !isEnabled(action.el)) await waitFor(() => (action = findForward()) && isEnabled(action.el), 5_000);
    if (!action) {
      stuck += 1;
      if (stuck >= 2) {
        const before = signature();
        const moved = await waitForPerson(send, `no Next or Submit button was found on ${host}. Finish this step in the tab and the run continues.`, () => signature() !== before);
        if (!moved) return report("FAILED", `No Next or Submit button found on ${host}`);
        stuck = 0;
      }
      await sleep(2_000);
      continue;
    }

    await say(send, `${host}: clicking ${action.kind === "submit" ? "Submit" : "Next"}`);
    const before = signature();
    press(action.el);
    if (action.kind === "submit") {
      const sent = await waitFor(() => submissionEvidence(), 15_000);
      if (sent) {
        await say(send, "application sent");
        return report("APPLIED", `Submitted on ${host} (${sent})`);
      }
    }
    if (await waitFor(() => signature() !== before, 8_000)) {
      stuck = 0;
      continue;
    }
    stuck += 1;
    if (stuck >= 2) {
      const missing = (answers?.requiredMissing ?? []).slice(0, 3).join("; ");
      const moved = await waitForPerson(send, `${host} did not accept this step${missing ? ` (needs: ${missing})` : ""}. Fix it in the tab, or click Next yourself, and the run continues.`, () => signature() !== before);
      if (!moved) return report("FAILED", `${host} did not accept this step${missing ? ` (needs: ${missing})` : ""}`);
      stuck = 0;
    }
  }
  return report("FAILED", `The application on ${host} had too many steps`);
}

/** Content-script entry: if this tab belongs to a Start run that is working on a company site, do this page and report back. */
export async function runExternalApplyIfAsked(send: Send) {
  if (window !== window.top || isPortalHost(location.hostname)) return;
  const task = await send<ExternalTask | null>({ type: "liApplyTask" });
  if (task?.kind !== "external" || !task.job || !task.candidate) return;
  const report = (outcome: "APPLIED" | "FAILED", reason?: string) => send({ type: "liApplyResult", seq: task.seq, kind: "job", outcome, reason });
  try {
    await drive(task, send, report);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not complete the application";
    await say(send, `problem: ${message}`);
    await report("FAILED", message);
  }
}
