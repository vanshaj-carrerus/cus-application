import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { Resume } from "@/lib/models/Resume";
import { upsertRecruiterTask } from "@/lib/automation/handoff";
import { decideHostPolicy } from "@/lib/automation/hostPolicy";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { ApplicationAttempt, type IApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { materializeStoredFile } from "@/lib/storage/fileStorage";
import { openApplySession, closeApplySession, persistSession, detectBoardFromUrl, remoteBrowserAvailable } from "@/lib/automation/browser";
import { detectCaptcha, solveCaptcha } from "@/lib/automation/captcha";
import { detectAuthWall, detectOtpWall, detectSuccessConfirmation } from "@/lib/automation/pageState";
import { dismissOverlays } from "@/lib/automation/overlays";
import { adapterFor } from "@/lib/automation/adapters";
import { confirmationCheckQueue, CONFIRMATION_CHECK_OPTIONS } from "@/lib/queue/queues";
import { bounded } from "@/lib/automation/bounded";
import { findEmailApplyTarget, sendApplicationEmail } from "@/lib/automation/emailApply";
import { attemptOtpChallenge } from "@/lib/automation/authLogin";
import { passLoginWall } from "@/lib/automation/signInFlow";
import {
  fillApplicationForm,
  findApplyButton,
  findSubmitButton,
  findNextButton,
  findFormContext,
  findClickableByText,
  attachResumeToUploadStep,
  listClickables,
  hasVisibleFormFields,
  classifyPageIntent,
  type PageIntent,
  waitForApplicationForm,
} from "@/lib/automation/formHeuristics";
import { captureProof } from "@/lib/automation/proof";
import { answerFormQuestions, summarizeQuestionResult } from "@/lib/automation/formQuestions";
import { judgeApplicationScreenshot, suggestNextClick, type ScreenshotDecision } from "@/lib/adapters/visionAdapter";
import type { Locator, Page } from "playwright";

const NAVIGATION_TIMEOUT_MS = 30_000;
// A single click/fill on a field that will not take it should cost seconds, not the 30s default: one stubborn
// field on a long form (or a slow remote browser) otherwise turns into minutes.
const ACTION_TIMEOUT_MS = 8_000;
const MAX_OPEN_FORM_ATTEMPTS = 6; // clicks on a "job description" page trying to reach the real form (JD -> "apply on company site" -> form)
const FORM_RENDER_WAIT_MS = 12_000; // how long to wait for a JS-rendered form after navigating/clicking
const NEW_TAB_WAIT_MS = 2_000; // an Apply link that opens a new tab does so right after the click
const MAX_WIZARD_STEPS = 6; // bound on a multi-page application (info -> experience -> resume -> review -> submit);
const MAX_AI_GUIDED_CLICKS = 4; // screenshot -> AI -> click, spent only when the free heuristics are stuck mid-flow
const MAX_AI_REVIEW_ATTEMPTS = 3; // how many times to retry before an unresolved outcome becomes FAILED

/**
 * Clicks a control and returns the page the flow should continue on: the new tab if the
 * click opened one (very common for "Apply" links, target=_blank / window.open), otherwise
 * the same page once its navigation settles.
 */
export async function clickAndFollow(page: Page, control: Locator): Promise<Page> {
  const newTab = page.context().waitForEvent("page", { timeout: NEW_TAB_WAIT_MS }).catch(() => null);
  await Promise.allSettled([page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }), control.click()]);
  const opened = await newTab;
  if (!opened) return page;

  await opened.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
  opened.setDefaultTimeout(ACTION_TIMEOUT_MS);
  opened.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await opened.bringToFront().catch(() => undefined);
  return opened;
}

async function addStep(
  attempt: IApplicationAttempt,
  step: string,
  status: "STARTED" | "SUCCESS" | "FAILED" | "SKIPPED",
  message?: string,
  screenshotUrl?: string
) {
  attempt.steps.push({ step, status, message, screenshotUrl, timestamp: new Date() });
  await attempt.save();
}

/**
 * Stage 3 of the auto-apply pipeline. Opens the job's apply page, clicks through to
 * the actual application form if the URL first lands on a job-description page,
 * fills whatever it recognizes across however many steps the form has, attaches the
 * tailored resume, and submits — unless a CAPTCHA/OTP/login wall stops it, in which
 * case it hands off to a human rather than guessing (see captcha.ts / pageState.ts).
 */
// Reasons that mean "the site refused THIS browser/address" rather than "the application is wrong". A
// different (residential) address can get past these; a different answer can't.
const SITE_BLOCK = /blocked this browser|you have been blocked|request blocked|access denied|rejected the 2captcha token|challenge page is still showing|security verification|bot (detection|protection|check)|cloudflare/i;

/**
 * Runs an application and, if the site blocked our browser, runs it once more through the residential remote
 * browser (when Bright Data is configured) before anyone is asked to step in. Other failures are not retried
 * here — a wrong answer or a missing login will not get better from a different address.
 */
export async function runApplyFlowEscalating(applicationId: string) {
  const first = await runApplyFlow(applicationId);
  if ("retryRemote" in first && first.retryRemote) return runApplyFlow(applicationId, { remote: true });
  return first;
}

export async function runApplyFlow(applicationId: string, options: { remote?: boolean } = {}) {
  await connectDB();

  const application = await Application.findById(applicationId);
  if (!application) throw new Error(`Application ${applicationId} not found`);

  const [candidate, job, resume] = await Promise.all([
    Candidate.findById(application.candidateId),
    Job.findById(application.jobId),
    application.resumeVersionId ? Resume.findById(application.resumeVersionId) : null,
  ]);
  if (!candidate) throw new Error(`Candidate ${application.candidateId} not found`);
  if (!job) throw new Error(`Job ${application.jobId} not found`);
  if (!job.applicationUrl) throw new Error(`Job ${job._id} has no applicationUrl to apply through`);
  if (!resume?.fileUrl) throw new Error(`Application ${applicationId} has no tailored resume PDF yet`);

  const board = detectBoardFromUrl(job.applicationUrl) ?? "OTHER";
  const priorAttempts = await ApplicationAttempt.countDocuments({ applicationId: application._id });

  // Sites the bot mostly fails on (or that risk the candidate's account) go straight to a recruiter, with
  // everything prepared — no browser, no wasted run. See hostPolicy.ts.
  const policy = await decideHostPolicy(String(candidate._id), job.applicationUrl);
  if (!policy.run) {
    const skipped = await ApplicationAttempt.create({
      applicationId: application._id,
      candidateId: candidate._id,
      jobId: job._id,
      board,
      attemptNumber: priorAttempts + 1,
      status: "NEEDS_REVIEW",
      startedAt: new Date(),
      finishedAt: new Date(),
      steps: [{ step: "host_policy", status: "SKIPPED", message: policy.reason, timestamp: new Date() }],
    });
    void skipped;
    application.automationStatus = "AWAITING_REVIEW";
    application.timeline.push({ status: application.status, note: `Not attempted automatically — ${policy.reason}`, changedAt: new Date() });
    await application.save();
    await upsertRecruiterTask({
      assignedTo: candidate.assignedRecruiterId,
      applicationId: application._id,
      candidateName: candidate.name,
      jobTitle: job.title,
      company: job.company,
      applicationUrl: job.applicationUrl,
      reason: policy.reason ?? "this site is not applied to automatically",
      kind: "MANUAL_APPLY",
      resumeUrl: resume.fileUrl,
    });
    return { applicationId, status: "NEEDS_REVIEW" as const, hostPolicy: policy.hostClass };
  }

  // The tailored resume lives in Cloudflare R2; Playwright's file input needs a local path.
  // Fetched before the attempt record exists so a download failure doesn't strand one in RUNNING.
  const resumeFile = await materializeStoredFile(resume.fileUrl);

  const attempt = await ApplicationAttempt.create({
    applicationId: application._id,
    candidateId: candidate._id,
    jobId: job._id,
    board,
    attemptNumber: priorAttempts + 1,
    status: "RUNNING",
    startedAt: new Date(),
  });

  application.automationStatus = "IN_PROGRESS";
  await application.save();

  const canEscalate = !options.remote && process.env.APPLY_REMOTE_BROWSER !== "true" && process.env.APPLY_AUTO_ESCALATE !== "false" && remoteBrowserAvailable();
  const session = await openApplySession(String(candidate._id), detectBoardFromUrl(job.applicationUrl), { remote: options.remote }).catch(async (err) => {
    await resumeFile.cleanup();
    throw err;
  });
  const resumeFilePath = resumeFile.path;
  const proofSubdir = `proofs/${candidate._id}`;

  // Non-null aliases: TS narrowing from the guard clauses above doesn't carry into
  // a nested closure, even though application/candidate/job are const and already
  // checked at this point.
  const app = application;
  const cand = candidate;
  const jobDoc = job;
  const contextPrompt = `This is an automated job application for candidate "${cand.name}" applying to "${jobDoc.title}" at "${jobDoc.company}".`;

  async function stopForHumanReview(
    stepName: string,
    attemptStatus: "BLOCKED_CAPTCHA" | "BLOCKED_LOGIN_REQUIRED" | "BLOCKED_OTP_REQUIRED" | "NEEDS_REVIEW",
    reason: string,
    page: Page
  ) {
    const proof = await captureProof(page, proofSubdir);
    await addStep(attempt, stepName, "FAILED", reason, proof.url);

    attempt.status = attemptStatus;
    attempt.finishedAt = new Date();
    await attempt.save();

    if (canEscalate && SITE_BLOCK.test(reason)) {
      // The site refused this browser. Retry through the residential one before bothering a recruiter.
      await addStep(attempt, "escalate_remote", "SUCCESS", "The site blocked this browser — retrying once through the residential remote browser");
      return { applicationId, status: attemptStatus, retryRemote: true as const };
    }

    app.automationStatus = "AWAITING_REVIEW";
    app.applicationProofScreenshot = proof.url;
    app.timeline.push({ status: app.status, note: `${reason} — needs manual completion`, changedAt: new Date() });
    await app.save();

    await upsertRecruiterTask({
      assignedTo: cand.assignedRecruiterId,
      applicationId: app._id,
      candidateName: cand.name,
      jobTitle: jobDoc.title,
      company: jobDoc.company,
      applicationUrl: jobDoc.applicationUrl,
      reason,
      kind: "MANUAL_APPLY",
      resumeUrl: resume?.fileUrl,
    });

    return { applicationId, status: attemptStatus };
  }

  /**
   * Runs the captcha / OTP / login-wall checks, in that order, against the current
   * page. Attempts to automatically solve any detected CAPTCHA challenge (see
   * lib/automation/captcha.ts) and attempts an automatic login if a saved credential matches
   * (see lib/automation/authLogin.ts).
   */
  async function checkWalls(
    page: Page,
    stepPrefix: string,
    options: { dismissSignInPopups?: boolean } = {}
  ): Promise<{ blocked: boolean; captchaSolved?: boolean; signedIn?: boolean; reason?: string; attemptStatus?: "BLOCKED_CAPTCHA" | "BLOCKED_OTP_REQUIRED" | "BLOCKED_LOGIN_REQUIRED" }> {
    // Cookie banners and pop-ups sit on top of the page and make it look like a wall (or hide the Apply
    // button). Sign-in pop-ups are only closed when asked — right after we clicked Apply, a sign-in
    // dialog is the wall to get through.
    const cleared = await bounded(dismissOverlays(page, { signInPopups: options.dismissSignInPopups ?? false }), 25_000, [] as string[]);
    if (cleared.length) await addStep(attempt, `${stepPrefix}_overlay`, "SUCCESS", `Closed what was covering the page: ${cleared.join(", ")}`);

    let captchaSolved = false;
    if (await bounded(detectCaptcha(page), 25_000, false)) {
      const solveResult = await solveCaptcha(page);
      if (solveResult.solved) {
        captchaSolved = solveResult.method !== "none";
        await addStep(attempt, `${stepPrefix}_captcha`, "SUCCESS", `CAPTCHA detected and solved automatically (${solveResult.method}): ${solveResult.message}`);
      } else {
        const reason = `CAPTCHA challenge detected and auto-solve failed: ${solveResult.message}`;
        await addStep(attempt, `${stepPrefix}_captcha`, "FAILED", reason);
        return { blocked: true, reason, attemptStatus: "BLOCKED_CAPTCHA" };
      }
    } else {
      await addStep(attempt, `${stepPrefix}_captcha`, "SUCCESS", "No CAPTCHA detected");
    }

    // Resolves an email-verification prompt by fetching the code from the candidate's
    // own connected inbox and submitting it. Returns handled=false when no prompt is
    // present, so the caller can log the "no prompt" step and re-run it after an
    // auth step that itself triggers a code. Only the account owner's connected
    // mailbox is ever read (see lib/automation/otpRetriever.ts).
    const resolveOtp = async (): Promise<{ handled: boolean; blocked: boolean; reason?: string; attemptStatus?: "BLOCKED_OTP_REQUIRED" }> => {
      if (!(await bounded(detectOtpWall(page), 20_000, false))) return { handled: false, blocked: false };

      const otpResult = await attemptOtpChallenge(page, String(cand._id));
      if (otpResult.success) {
        await addStep(
          attempt,
          `${stepPrefix}_otp`,
          "SUCCESS",
          `Verification code retrieved from the candidate's connected inbox${otpResult.from ? ` (sender ${otpResult.from})` : ""} and submitted automatically`
        );
        return { handled: true, blocked: false };
      }

      const reason = `Verification-code step failed — ${otpResult.reason ?? "no code could be entered"}`;
      await addStep(attempt, `${stepPrefix}_otp`, "FAILED", reason);
      return { handled: true, blocked: true, reason, attemptStatus: "BLOCKED_OTP_REQUIRED" };
    };

    const otpBefore = await resolveOtp();
    if (otpBefore.blocked) return { blocked: true, reason: otpBefore.reason, attemptStatus: otpBefore.attemptStatus };
    if (!otpBefore.handled) await addStep(attempt, `${stepPrefix}_otp`, "SUCCESS", "No verification-code prompt detected");

    if (await bounded(detectAuthWall(page), 25_000, false)) {
      // One state machine handles every shape of wall: sign-in options -> "Continue with email" ->
      // email -> password or code-only -> verification code from the candidate's Gmail (signInFlow.ts).
      const flow = await bounded(
        passLoginWall(page, String(cand._id), { name: cand.name, email: cand.email, phone: cand.phone }),
        5 * 60_000,
        { success: false, attempted: true, steps: [], reason: "the sign-in steps stopped responding", failure: "login" as const }
      );
      if (flow.success) {
        const how = flow.method === "saved_login" ? "saved login" : flow.method === "new_account" ? "new account" : "email code";
        await addStep(attempt, `${stepPrefix}_auth`, "SUCCESS", `Passed the sign-in wall (${how}): ${flow.steps.join(" → ")}`);
        // A sign-in can also trigger a 2FA/email code that appears after the page settles — clear it too.
        const otpAfterLogin = await resolveOtp();
        if (otpAfterLogin.blocked) return { blocked: true, reason: otpAfterLogin.reason, attemptStatus: otpAfterLogin.attemptStatus };
        return { blocked: false, captchaSolved, signedIn: true };
      }

      const done = flow.steps.length ? ` (got as far as: ${flow.steps.join(" → ")})` : "";
      const reason = flow.attempted ? `Sign-in wall not cleared — ${flow.reason}${done}` : `Sign-in required — ${flow.reason}`;
      await addStep(attempt, `${stepPrefix}_auth`, "FAILED", reason);
      return { blocked: true, reason, attemptStatus: flow.failure === "otp" ? "BLOCKED_OTP_REQUIRED" : "BLOCKED_LOGIN_REQUIRED" };
    }
    await addStep(attempt, `${stepPrefix}_auth`, "SUCCESS", "No login wall detected");

    return { blocked: false, captchaSolved };
  }

  // If the page we were driving was closed (a site that swaps tabs, or a crashed remote tab), carry on with
  // the newest tab that is still open instead of failing on a dead handle.
  const livePage = (p: Page): Page => (p.isClosed() ? (session.context.pages().filter((x) => !x.isClosed()).pop() ?? p) : p);

  const uploadedOn = new Set<string>();
  let aiGuidedClicksUsed = 0;
  // Controls the AI already had us press on a given page. If pressing one changed nothing, pressing it again
  // won't either — so it is withheld from the next question and the AI must choose something else.
  const aiClicked = new Set<string>();
  const clickKey = (p: Page, text: string) => `${p.url().split("#")[0]}|${text.trim().toLowerCase()}`;
  /**
   * The "stuck" path: take a screenshot, ask the vision model what to click next, and click it.
   * Returns the page to continue on (it may be a new tab), or null when the AI says it is done,
   * needs a human, or no usable control could be found.
   */
  async function aiGuidedClick(page: Page, why: string): Promise<Page | null> {
    if (aiGuidedClicksUsed >= MAX_AI_GUIDED_CLICKS) return null;
    if (await detectSuccessConfirmation(page)) return null;
    aiGuidedClicksUsed++;

    const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
    const controls = (await bounded(listClickables(page), 15_000, [] as string[])).filter((c) => !aiClicked.has(clickKey(page, c)));
    const suggestion = screenshot ? await suggestNextClick(screenshot, contextPrompt, controls) : null;
    if (!suggestion) {
      await addStep(attempt, "ai_next_click", "FAILED", `${why} — vision model unavailable or returned nothing usable`);
      return null;
    }
    if (suggestion.action !== "CLICK" || !suggestion.controlText) {
      await addStep(attempt, "ai_next_click", suggestion.action === "DONE" ? "SUCCESS" : "FAILED", `${suggestion.action}: ${suggestion.reasoning}`);
      return null;
    }

    if (/\b(with|using|via|through)\s+(linkedin|indeed|google|facebook|apple|microsoft|twitter|github|glassdoor)\b/i.test(suggestion.controlText)) {
      await addStep(attempt, "ai_next_click", "FAILED", `AI chose "${suggestion.controlText}", a login through another site's account — skipped`);
      return null;
    }
    if (aiClicked.has(clickKey(page, suggestion.controlText))) {
      await addStep(attempt, "ai_next_click", "FAILED", `AI chose "${suggestion.controlText}" again, but pressing it already changed nothing on this page`);
      return null;
    }
    const control = await findClickableByText(page, suggestion.controlText);
    if (!control) {
      await addStep(attempt, "ai_next_click", "FAILED", `AI chose "${suggestion.controlText}" but no matching control exists on the page — ${suggestion.reasoning}`);
      return null;
    }
    aiClicked.add(clickKey(page, suggestion.controlText));

    // A "click to browse & upload" area opens the browser's file picker. There is no window to pick from, so
    // answer the picker with the tailored resume — the same file the form filler would attach.
    if (/\b(upload|browse|attach|choose (a )?file|select (a )?file|drop (your )?(resume|cv))\b/i.test(suggestion.controlText)) {
      const picked = await Promise.all([page.waitForEvent("filechooser", { timeout: 6_000 }).catch(() => null), control.click().catch(() => undefined)]);
      if (picked[0]) {
        await picked[0].setFiles(resumeFilePath);
        await page.waitForTimeout(2_500);
        await addStep(attempt, "ai_next_click", "SUCCESS", `Attached the tailored resume through the page's upload area ("${suggestion.controlText}")`);
        await bounded(waitForApplicationForm(page, 6_000), 20_000, false);
        return page;
      }
    }
    const next = await clickAndFollow(page, control);
    await addStep(attempt, "ai_next_click", "SUCCESS", `Clicked "${suggestion.controlText}" on the AI's advice (${why}): ${suggestion.reasoning}`);
    await bounded(waitForApplicationForm(next, 6_000), 20_000, false);
    return next;
  }

  // Hard stop for the whole run. Some failures are silent hangs (a remote browser that stops answering, a
  // page that never settles); without this one of them holds a worker slot forever and the application
  // sits "in progress" with nobody told. Closing the browser makes whatever is waiting fail right away.
  const runTimeoutMs = Number(process.env.APPLY_RUN_TIMEOUT_MS) || 10 * 60_000;
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void session.browser.close().catch(() => undefined);
  }, runTimeoutMs);

  try {
    let page = await session.context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const entryUrl = adapterFor(job.applicationUrl)?.applicationUrl?.(job.applicationUrl) ?? job.applicationUrl;
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    await addStep(attempt, "navigate", "SUCCESS", entryUrl !== job.applicationUrl ? `${entryUrl} (the platform's direct application address)` : entryUrl);
    // Let JS-rendered content (the form, or the Apply button) appear before classifying anything.
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);

    const initialWalls = await checkWalls(page, "initial", { dismissSignInPopups: true });
    if (initialWalls.blocked) {
      return await stopForHumanReview("initial_wall", initialWalls.attemptStatus!, initialWalls.reason!, page);
    }

    // The applicationUrl is usually a job description (or a job-board preview page), not the form. Keep
    // going, hop by hop, until a form is showing: find the Apply control (heuristics first, then the AI
    // choosing from the page's real list of controls), click it, get through any sign-in wall that
    // appears, and look again. A job description is never a reason to stop and wait for a person.
    let signInsPassed = 0;
    const clickedBefore = new Set<string>();
    for (let hop = 0; hop < MAX_OPEN_FORM_ATTEMPTS; hop++) {
      page = livePage(page);
      const platformNote = await bounded(adapterFor(page.url())?.advance?.(page) ?? Promise.resolve(null), 20_000, null);
      if (platformNote) await addStep(attempt, "platform_step", "SUCCESS", platformNote);
      const intent = await bounded(classifyPageIntent(page), 25_000, "UNKNOWN" as PageIntent);
      await addStep(attempt, "page_intent", "SUCCESS", `${intent} — ${page.url()}`);
      if (intent === "APPLICATION_FORM") break;
      if (await detectSuccessConfirmation(page)) break;

      let applyButton = await bounded(findApplyButton(page), 20_000, null);
      if (!applyButton) {
        // Probably covered by a pop-up or consent banner — clear it and look again.
        const cleared = await bounded(dismissOverlays(page, { signInPopups: true }), 25_000, [] as string[]);
        if (cleared.length) {
          await addStep(attempt, "dismiss_overlay", "SUCCESS", `Closed what was covering the page: ${cleared.join(", ")}`);
          applyButton = await bounded(findApplyButton(page), 20_000, null);
        }
      }

      // Never press the same control twice on the same page: if it did nothing the first time, the AI picks something else.
      let applyLabel = "";
      if (applyButton) {
        applyLabel = (await applyButton.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const key = `${page.url()}|${applyLabel.toLowerCase()}`;
        if (clickedBefore.has(key)) applyButton = null;
        else clickedBefore.add(key);
      }

      let next: Page | null;
      if (applyButton) {
        const before = page.url();
        next = await clickAndFollow(page, applyButton);
        await addStep(attempt, "click_apply", "SUCCESS", `Clicked "${applyLabel || "Apply"}"${next.url() !== before ? ` — now at ${next.url()}` : ""}`);
        // The form is usually injected by JS after the click; classify only once it had a chance to render.
        await bounded(waitForApplicationForm(next, FORM_RENDER_WAIT_MS), FORM_RENDER_WAIT_MS + 15_000, false);
      } else {
        // A page that tells applicants to email their resume has nothing to click: leave it to the email step below
        // rather than letting the AI wander off to a chat link.
        if (await bounded(findEmailApplyTarget(page, [cand.email ?? ""]), 20_000, null)) break;
        next = await aiGuidedClick(page, `no usable Apply control found on ${new URL(page.url()).hostname}`);
      }
      if (!next) break;
      page = next;

      const wallsAfterClick = await checkWalls(page, `post_apply_${hop}`);
      if (wallsAfterClick.blocked) {
        return await stopForHumanReview("post_apply_wall", wallsAfterClick.attemptStatus!, wallsAfterClick.reason!, page);
      }
      if (wallsAfterClick.signedIn && ++signInsPassed >= 3) {
        return await stopForHumanReview("repeated_sign_in", "BLOCKED_LOGIN_REQUIRED", "Signed in more than twice but the site keeps asking to sign in again", page);
      }
    }

    // No form and nothing left to click: some postings simply say "email your resume to …". That is a normal way
    // to apply, so do it — from the candidate's own Gmail, with the tailored cover letter and resume attached.
    page = livePage(page);
    if ((await bounded(classifyPageIntent(page), 25_000, "UNKNOWN" as PageIntent)) !== "APPLICATION_FORM") {
      const target = await bounded(findEmailApplyTarget(page, [cand.email ?? ""]), 20_000, null);
      if (target) {
        await addStep(attempt, "email_apply_found", "SUCCESS", `No form on this page — it asks applicants to email ${target.email}: "${target.evidence}"`);
        if (process.env.APPLY_DRY_RUN === "true") {
          const proof = await captureProof(page, proofSubdir);
          await addStep(attempt, "dry_run", "SUCCESS", `APPLY_DRY_RUN is on — the application email to ${target.email} was NOT sent`, proof.url);
          attempt.status = "NEEDS_REVIEW";
          attempt.finishedAt = new Date();
          await attempt.save();
          app.automationStatus = "AWAITING_REVIEW";
          await app.save();
          return { applicationId, status: "NEEDS_REVIEW" as const };
        }
        try {
          const sent = await sendApplicationEmail({
            candidateId: String(cand._id),
            candidate: { name: cand.name, email: cand.email, phone: cand.phone },
            job: { _id: jobDoc._id, title: jobDoc.title, company: jobDoc.company },
            applicationId: String(app._id),
            to: target.email,
            coverLetter: app.coverLetter,
            resumePath: resumeFilePath,
          });
          const proof = await captureProof(page, proofSubdir);
          const note = `Applied by email: "${sent.subject}" sent from ${sent.from} to ${target.email} with the tailored resume attached`;
          await addStep(attempt, "email_apply_sent", "SUCCESS", note, proof.url);
          attempt.status = "SUCCESS";
          attempt.submissionConfirmation = { finalUrl: page.url(), aiReasoning: note };
          attempt.finishedAt = new Date();
          await attempt.save();
          application.status = "APPLIED";
          application.automationStatus = "SUBMITTED";
          application.appliedAt = new Date();
          application.applicationProofScreenshot = proof.url;
          application.timeline.push({ status: "APPLIED", note, changedAt: new Date() });
          await application.save();
          await AutoApplyProfile.updateOne({ candidateId: candidate._id }, { $inc: { appliedToday: 1 } });
          return { applicationId, status: "APPLIED" as const, proofUrl: proof.url };
        } catch (err) {
          // Not sent (no Gmail connected, send refused…): say why and let the normal hand-off report it.
          await addStep(attempt, "email_apply_sent", "FAILED", `Could not send the application email to ${target.email}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    for (let step = 0; step < MAX_WIZARD_STEPS; step++) {
      page = livePage(page);
      let formCtx = await findFormContext(page);
      let stepIntent = await bounded(classifyPageIntent(formCtx), 25_000, "UNKNOWN" as PageIntent);
      if (stepIntent !== "APPLICATION_FORM" && (await bounded(waitForApplicationForm(page, step === 0 ? FORM_RENDER_WAIT_MS : 4_000), 30_000, false))) {
        formCtx = await findFormContext(page);
        stepIntent = await bounded(classifyPageIntent(formCtx), 25_000, "UNKNOWN" as PageIntent);
      }
      await addStep(attempt, "page_intent", "SUCCESS", `step=${step}: ${stepIntent} — ${page.url()}`);

      if (stepIntent !== "APPLICATION_FORM") {
        // A wizard that opens on "upload your resume": give it the tailored resume, then look again.
        const uploadKey = page.url().split("#")[0];
        if (!uploadedOn.has(uploadKey)) {
          uploadedOn.add(uploadKey);
          if (await bounded(attachResumeToUploadStep(page, resumeFilePath), 40_000, false)) {
            await addStep(attempt, "attach_resume", "SUCCESS", "Attached the tailored resume on the page's upload step");
            await page.waitForTimeout(3_000);
            continue;
          }
        }
        // Not a form, and not (yet) a confirmation either. Rather than give up, show the page to the
        // AI and let it say what to click (cookie banner, "Apply" on an interstitial, "Continue"...).
        const guided = await aiGuidedClick(page, `step=${step} is not a form`);
        if (guided) {
          page = guided;
          const wallsAfterGuided = await checkWalls(page, `ai_click_${step}`);
          if (wallsAfterGuided.blocked) {
            return await stopForHumanReview("ai_click_wall", wallsAfterGuided.attemptStatus!, wallsAfterGuided.reason!, page);
          }
          continue;
        }
        // Nothing left to fill — either the wizard is done or it dead-ended. The AI review below decides.
        break;
      }

      const fillResult = await fillApplicationForm(formCtx, cand, resumeFilePath);
      attempt.formFieldsFilled = { ...fillResult, step };
      await addStep(attempt, "fill_form", "SUCCESS", `step=${step}, ATS=${fillResult.ats}, resumeAttached=${fillResult.resumeAttached}`);

      // The fixed selectors above only know name/email/phone/resume. Everything else the form asks is
      // answered from the candidate's profile — and if a required question can't be, stop *before*
      // submitting rather than send an incomplete or guessed application.
      const questions = await answerFormQuestions(formCtx, cand, jobDoc, app.coverLetter);
      if (questions.asked > 0) {
        await addStep(attempt, "answer_questions", questions.requiredMissing.length ? "FAILED" : "SUCCESS", `step=${step}: ${summarizeQuestionResult(questions)}`);
      }
      if (questions.requiredMissing.length) {
        return await stopForHumanReview(
          "form_questions",
          "NEEDS_REVIEW",
          `Required question(s) the candidate's profile can't answer: ${questions.requiredMissing.map((q) => `"${q}"`).join(", ")}`,
          page
        );
      }

      const submitButton = await findSubmitButton(formCtx);
      const nextButton = !submitButton ? await findNextButton(formCtx) : null;
      const control = submitButton ?? nextButton;

      if (!control) {
        await addStep(attempt, "form_dead_end", "FAILED", `No Submit or Next control found on step ${step}`);
        const guided = await aiGuidedClick(page, `no Submit/Next control found on step ${step}`);
        if (guided) {
          page = guided;
          continue;
        }
        break;
      }

      // A CAPTCHA token expires in ~2 minutes and is verified when the form is submitted, so
      // solve (or refresh) it now, right before the click, instead of relying on an earlier solve.
      if (await bounded(detectCaptcha(page), 25_000, false)) {
        const presubmit = await solveCaptcha(page);
        await addStep(attempt, `step_${step}_presubmit_captcha`, presubmit.solved ? "SUCCESS" : "FAILED", presubmit.message);
        if (!presubmit.solved) {
          return await stopForHumanReview("presubmit_captcha_wall", "BLOCKED_CAPTCHA", `CAPTCHA on the form could not be solved: ${presubmit.message}`, page);
        }
      }

      if (submitButton && process.env.APPLY_DRY_RUN === "true") {
        // Test mode: everything up to the final click is real; the click is not. No recruiter task is created.
        const proof = await captureProof(page, proofSubdir);
        await addStep(attempt, "dry_run", "SUCCESS", "APPLY_DRY_RUN is on — the form is filled and ready; the final Submit was NOT clicked", proof.url);
        attempt.status = "NEEDS_REVIEW";
        attempt.finishedAt = new Date();
        await attempt.save();
        app.automationStatus = "AWAITING_REVIEW";
        await app.save();
        return { applicationId, status: "NEEDS_REVIEW" as const };
      }

      await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }), control.click()]);
      await addStep(attempt, submitButton ? "submit" : "next_step", "SUCCESS", submitButton ? "Submit control clicked" : "Advanced to next step");

      const wallsAfterClick = await checkWalls(page, `step_${step}`);
      if (wallsAfterClick.blocked) {
        return await stopForHumanReview("step_wall", wallsAfterClick.attemptStatus!, wallsAfterClick.reason!, page);
      }

      // A challenge that only appeared after the click (invisible reCAPTCHA / bot check on submit)
      // was solved above, but the click it interrupted never completed — submit again now that the
      // page holds a valid token, instead of moving on as if the form had gone through.
      if (wallsAfterClick.captchaSolved) {
        const againCtx = await findFormContext(page);
        if (await hasVisibleFormFields(againCtx)) {
          const again = (await findSubmitButton(againCtx)) ?? (await findNextButton(againCtx));
          if (again) {
            await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }), again.click()]);
            await addStep(attempt, "resubmit_after_captcha", "SUCCESS", "CAPTCHA appeared after the click and was solved — clicked submit/next again");
          }
        }
      }

      if (submitButton && !(await hasVisibleFormFields(await findFormContext(page)))) {
        // Clicked what looks like the terminal submit and nothing left to fill —
        // this is the point to hand off to AI review below rather than looping again.
        break;
      }
    }

    // Final outcome is decided by looking at the actual screenshot rather than
    // trusting text/URL heuristics alone. Retries up to MAX_AI_REVIEW_ATTEMPTS times
    // on a "fixable-looking" problem before giving up as FAILED; stops immediately
    // if the AI says either "done" (APPLIED) or "needs a human" (NEEDS_REVIEW).
    let finalProof = await captureProof(page, proofSubdir);
    let finalStatus: "APPLIED" | "FAILED" | "NEEDS_REVIEW" = "NEEDS_REVIEW";
    let finalReason = "Automation could not determine whether the application was submitted";

    for (let i = 1; i <= MAX_AI_REVIEW_ATTEMPTS; i++) {
      const platformProof = await bounded(adapterFor(page.url())?.confirmed?.(page) ?? Promise.resolve(null), 10_000, null);
      const judgment = platformProof ? null : await judgeApplicationScreenshot(finalProof.buffer, contextPrompt);
      let decision: ScreenshotDecision;
      let reasoning: string;
      if (platformProof) {
        decision = "SUBMITTED";
        reasoning = `${platformProof} (the platform's own confirmation, not an AI reading of a screenshot)`;
      } else if (judgment) {
        decision = judgment.decision;
        reasoning = judgment.reasoning;
      } else {
        // Vision unavailable (no GEMINI_API_KEY, or the call failed) — fall back to
        // the URL/text heuristic rather than blocking the whole pipeline on it.
        const heuristicConfirmed = await detectSuccessConfirmation(page);
        decision = heuristicConfirmed ? "SUBMITTED" : i === MAX_AI_REVIEW_ATTEMPTS ? "NEEDS_HUMAN" : "RETRY";
        reasoning = heuristicConfirmed
          ? "Confirmation text/URL pattern matched (AI screenshot review unavailable)"
          : "No confirmation pattern found (AI screenshot review unavailable)";
      }

      await addStep(attempt, "ai_review", decision === "SUBMITTED" ? "SUCCESS" : "FAILED", `[${i}/${MAX_AI_REVIEW_ATTEMPTS}] ${decision}: ${reasoning}`, finalProof.url);
      finalReason = reasoning;

      if (decision === "SUBMITTED") {
        finalStatus = "APPLIED";
        break;
      }
      if (decision === "FAILED_HARD") {
        finalStatus = "FAILED";
        break;
      }
      if (decision === "NEEDS_HUMAN") {
        finalStatus = "NEEDS_REVIEW";
        break;
      }

      // decision === "RETRY"
      if (i === MAX_AI_REVIEW_ATTEMPTS) {
        finalStatus = "FAILED";
        finalReason = `Retried ${MAX_AI_REVIEW_ATTEMPTS} times without resolving — last issue: ${reasoning}`;
        break;
      }

      const wallsOnRetry = await checkWalls(page, `ai_retry_${i}`);
      if (wallsOnRetry.blocked) {
        return await stopForHumanReview("ai_retry_wall", wallsOnRetry.attemptStatus!, wallsOnRetry.reason!, page);
      }

      const retryCtx = await findFormContext(page);
      if (await hasVisibleFormFields(retryCtx)) {
        const retryFill = await fillApplicationForm(retryCtx, cand, resumeFilePath);
        await addStep(attempt, "retry_fill", "SUCCESS", `retry ${i}: ATS=${retryFill.ats}, resumeAttached=${retryFill.resumeAttached}`);
        const retryQuestions = await answerFormQuestions(retryCtx, cand, jobDoc, app.coverLetter);
        if (retryQuestions.asked > 0) {
          await addStep(attempt, "answer_questions", retryQuestions.requiredMissing.length ? "FAILED" : "SUCCESS", `retry ${i}: ${summarizeQuestionResult(retryQuestions)}`);
        }
        if (retryQuestions.requiredMissing.length) {
          return await stopForHumanReview(
            "form_questions",
            "NEEDS_REVIEW",
            `Required question(s) the candidate's profile can't answer: ${retryQuestions.requiredMissing.map((q) => `"${q}"`).join(", ")}`,
            page
          );
        }
        const retryControl = (await findSubmitButton(retryCtx)) ?? (await findNextButton(retryCtx));
        if (retryControl) {
          await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }), retryControl.click()]);
          await addStep(attempt, "retry_submit", "SUCCESS", `retry ${i}: clicked submit/next again`);
        }
      }

      finalProof = await captureProof(page, proofSubdir);
    }

    if (finalStatus === "APPLIED") {
      attempt.status = "SUCCESS";
      attempt.submissionConfirmation = { finalUrl: page.url(), aiReasoning: finalReason };
      attempt.finishedAt = new Date();
      await attempt.save();

      application.status = "APPLIED";
      application.automationStatus = "SUBMITTED";
      application.appliedAt = new Date();
      application.applicationProofScreenshot = finalProof.url;
      application.timeline.push({ status: "APPLIED", note: `Submitted via automated apply (AI-confirmed: ${finalReason})`, changedAt: new Date() });
      await application.save();

      await AutoApplyProfile.updateOne({ candidateId: candidate._id }, { $inc: { appliedToday: 1 } });
      await persistSession(session);

      // Second opinion: look for the employer's confirmation email in the candidate's Gmail. A queue problem
      // must never turn a successful application into an error.
      await confirmationCheckQueue()
        .add("check", { applicationId }, CONFIRMATION_CHECK_OPTIONS)
        .catch((err) => console.warn("[confirmation] could not schedule the email check:", err instanceof Error ? err.message : err));

      return { applicationId, status: "APPLIED" as const, proofUrl: finalProof.url };
    }

    if (finalStatus === "FAILED") {
      attempt.status = "FAILED";
      attempt.errorMessage = finalReason;
      attempt.finishedAt = new Date();
      await attempt.save();

      if (canEscalate && SITE_BLOCK.test(finalReason)) {
        await addStep(attempt, "escalate_remote", "SUCCESS", "The site blocked this browser — retrying once through the residential remote browser");
        return { applicationId, status: "FAILED" as const, failureReason: finalReason, retryRemote: true as const };
      }

      application.automationStatus = "FAILED";
      application.failureReason = finalReason;
      application.applicationProofScreenshot = finalProof.url;
      application.timeline.push({ status: application.status, note: `Automated apply failed after retries: ${finalReason}`, changedAt: new Date() });
      await application.save();

      await upsertRecruiterTask({
        assignedTo: cand.assignedRecruiterId,
        applicationId: app._id,
        candidateName: cand.name,
        jobTitle: jobDoc.title,
        company: jobDoc.company,
        applicationUrl: jobDoc.applicationUrl,
        reason: `retried ${MAX_AI_REVIEW_ATTEMPTS} times and could not get past: ${finalReason}`,
        kind: "FAILED",
        resumeUrl: resume?.fileUrl,
      });

      return { applicationId, status: "FAILED" as const, failureReason: finalReason };
    }

    return await stopForHumanReview("ai_needs_review", "NEEDS_REVIEW", finalReason, page);
  } catch (err) {
    const message = timedOut
      ? `Timed out after ${Math.round(runTimeoutMs / 60_000)} minutes — the page or browser stopped responding (last error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`
      : err instanceof Error
        ? err.message
        : String(err);
    let proofUrl: string | undefined;
    try {
      const page = session.context.pages()[0];
      if (page) proofUrl = (await captureProof(page, proofSubdir)).url;
    } catch {
      // best-effort — a failed screenshot shouldn't mask the original error
    }

    await addStep(attempt, "error", "FAILED", message, proofUrl);
    attempt.status = "FAILED";
    attempt.errorMessage = message;
    attempt.finishedAt = new Date();
    await attempt.save();

    application.automationStatus = "FAILED";
    application.failureReason = message;
    if (proofUrl) application.applicationProofScreenshot = proofUrl;
    application.timeline.push({ status: application.status, note: `Automated apply failed: ${message}`, changedAt: new Date() });
    await application.save();

    return { applicationId, status: "FAILED" as const, failureReason: message };
  } finally {
    clearTimeout(watchdog);
    await closeApplySession(session).catch(() => undefined);
    await resumeFile.cleanup();
  }
}
