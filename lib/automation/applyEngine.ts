import { connectDB } from "@/lib/db/mongodb";
import { Application } from "@/lib/models/Application";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { Resume } from "@/lib/models/Resume";
import { Task } from "@/lib/models/Task";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { ApplicationAttempt, type IApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { storedFilePath } from "@/lib/storage/fileStorage";
import { openApplySession, closeApplySession, persistSession, detectBoardFromUrl } from "@/lib/automation/browser";
import { detectCaptcha } from "@/lib/automation/captcha";
import { detectAuthWall, detectOtpWall, detectSuccessConfirmation } from "@/lib/automation/pageState";
import { attemptAutoLogin, attemptAutoSignup } from "@/lib/automation/authLogin";
import {
  fillApplicationForm,
  findApplyButton,
  findSubmitButton,
  findNextButton,
  findFormContext,
  findClickableByText,
  hasVisibleFormFields,
  classifyPageIntent,
} from "@/lib/automation/formHeuristics";
import { captureProof } from "@/lib/automation/proof";
import { judgeApplicationScreenshot, locateApplyTarget, type ScreenshotDecision } from "@/lib/adapters/visionAdapter";
import type { Page } from "playwright";

const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_OPEN_FORM_ATTEMPTS = 2; // clicks on a "job description" page trying to reach the real form
const MAX_WIZARD_STEPS = 6; // bound on a multi-page application (info -> experience -> resume -> review -> submit)
const MAX_AI_REVIEW_ATTEMPTS = 3; // how many times to retry before an unresolved outcome becomes FAILED

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
export async function runApplyFlow(applicationId: string) {
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

  const session = await openApplySession(String(candidate._id), detectBoardFromUrl(job.applicationUrl));
  const resumeFilePath = storedFilePath(resume.fileUrl);
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

    app.automationStatus = "AWAITING_REVIEW";
    app.applicationProofScreenshot = proof.url;
    app.timeline.push({ status: app.status, note: `${reason} — needs manual completion`, changedAt: new Date() });
    await app.save();

    if (cand.assignedRecruiterId) {
      await Task.create({
        assignedTo: cand.assignedRecruiterId,
        title: `Manually complete application: ${cand.name} → ${jobDoc.title} @ ${jobDoc.company}`,
        description: `Automated apply stopped: ${reason}. Finish this application by hand: ${jobDoc.applicationUrl}`,
        entityType: "APPLICATION",
        entityId: app._id,
        priority: "HIGH",
        source: "AI_SUGGESTED",
        aiReasoning: reason,
      });
    }

    return { applicationId, status: attemptStatus };
  }

  /**
   * Runs the captcha / OTP / login-wall checks, in that order, against the current
   * page. Attempts an automatic login if a saved credential matches (see
   * lib/automation/authLogin.ts) — everything else here is detect-only and hands
   * off to a human rather than trying to solve it.
   */
  async function checkWalls(page: Page, stepPrefix: string): Promise<{ blocked: boolean; reason?: string; attemptStatus?: "BLOCKED_CAPTCHA" | "BLOCKED_OTP_REQUIRED" | "BLOCKED_LOGIN_REQUIRED" }> {
    if (await detectCaptcha(page)) {
      const reason = "CAPTCHA challenge detected — auto-solving is intentionally not supported";
      await addStep(attempt, `${stepPrefix}_captcha`, "FAILED", reason);
      return { blocked: true, reason, attemptStatus: "BLOCKED_CAPTCHA" };
    }
    await addStep(attempt, `${stepPrefix}_captcha`, "SUCCESS", "No CAPTCHA detected");

    if (await detectOtpWall(page)) {
      const reason = "Verification-code prompt detected — this is never auto-solved";
      await addStep(attempt, `${stepPrefix}_otp`, "FAILED", reason);
      return { blocked: true, reason, attemptStatus: "BLOCKED_OTP_REQUIRED" };
    }
    await addStep(attempt, `${stepPrefix}_otp`, "SUCCESS", "No verification-code prompt detected");

    if (await detectAuthWall(page)) {
      const loginResult = await attemptAutoLogin(page, String(cand._id));
      if (loginResult.success) {
        await addStep(attempt, `${stepPrefix}_auth`, "SUCCESS", `Logged in automatically using saved ${loginResult.credentialLabel} credentials`);
        return { blocked: false };
      }

      if (loginResult.attempted) {
        const reason = `Sign-in required — automated login with saved ${loginResult.credentialLabel} credentials failed`;
        await addStep(attempt, `${stepPrefix}_auth`, "FAILED", reason);
        return { blocked: true, reason, attemptStatus: "BLOCKED_LOGIN_REQUIRED" };
      }

      // No saved credential matched this site — register a new account instead of
      // stopping immediately, so the wall only blocks the run when we truly can't
      // get past it (e.g. no on-file candidate email, or the signup itself fails).
      const signupResult = await attemptAutoSignup(page, String(cand._id), { name: cand.name, email: cand.email, phone: cand.phone });
      if (signupResult.success) {
        await addStep(attempt, `${stepPrefix}_auth`, "SUCCESS", `Registered a new account automatically (${signupResult.loginId}) and saved the credentials`);
        return { blocked: false };
      }

      const reason = signupResult.attempted
        ? "Sign-in/account creation required — automated signup did not clear the wall"
        : "Sign-in/account creation required, no saved credentials match this site, and no candidate email is on file to auto-register with";
      await addStep(attempt, `${stepPrefix}_auth`, "FAILED", reason);
      return { blocked: true, reason, attemptStatus: "BLOCKED_LOGIN_REQUIRED" };
    }
    await addStep(attempt, `${stepPrefix}_auth`, "SUCCESS", "No login wall detected");

    return { blocked: false };
  }

  try {
    const page = await session.context.newPage();
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

    await page.goto(job.applicationUrl, { waitUntil: "domcontentloaded" });
    await addStep(attempt, "navigate", "SUCCESS", job.applicationUrl);

    const initialWalls = await checkWalls(page, "initial");
    if (initialWalls.blocked) {
      return await stopForHumanReview("initial_wall", initialWalls.attemptStatus!, initialWalls.reason!, page);
    }

    // The applicationUrl often lands on a job-description page with an "Apply"
    // control, not the form itself — click through to the real form before trying
    // to fill anything. classifyPageIntent is the zero-cost DOM/URL router deciding
    // that, logged explicitly so it's visible in the attempt trail.
    for (let i = 0; i < MAX_OPEN_FORM_ATTEMPTS; i++) {
      let intent = await classifyPageIntent(page);
      await addStep(attempt, "page_intent", "SUCCESS", `${intent} — ${page.url()}`);

      // The free DOM/URL heuristics don't recognize every layout (icon-only
      // controls, unusual copy, JS-rendered widgets). When they come up empty,
      // fall back to a vision call to actually look at the page like a human would
      // before giving up — this is the main fix for "AI can't find the apply button".
      let applyButton = intent === "APPLICATION_FORM" ? null : await findApplyButton(page);
      if (intent !== "APPLICATION_FORM" && !applyButton) {
        const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
        const aiTarget = screenshot ? await locateApplyTarget(screenshot, contextPrompt) : null;
        if (aiTarget) {
          await addStep(
            attempt,
            "ai_page_intent",
            "SUCCESS",
            `${aiTarget.pageIntent} — ${aiTarget.reasoning}${aiTarget.controlText ? ` (control: "${aiTarget.controlText}")` : ""}`
          );
          if (aiTarget.pageIntent === "APPLICATION_FORM") intent = "APPLICATION_FORM";
          if (aiTarget.controlText) applyButton = await findClickableByText(page, aiTarget.controlText);
        }
      }

      if (intent === "APPLICATION_FORM") break;
      if (!applyButton) break;

      await Promise.allSettled([page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }), applyButton.click()]);
      await addStep(attempt, "click_apply", "SUCCESS", "Clicked through to the application form");

      const wallsAfterApply = await checkWalls(page, `post_apply_${i}`);
      if (wallsAfterApply.blocked) {
        return await stopForHumanReview("post_apply_wall", wallsAfterApply.attemptStatus!, wallsAfterApply.reason!, page);
      }
    }

    for (let step = 0; step < MAX_WIZARD_STEPS; step++) {
      const formCtx = await findFormContext(page);
      const stepIntent = await classifyPageIntent(formCtx);
      await addStep(attempt, "page_intent", "SUCCESS", `step=${step}: ${stepIntent} — ${page.url()}`);

      if (stepIntent !== "APPLICATION_FORM") {
        // Nothing left to fill — either the wizard is done or it dead-ended before
        // ever finding a submit control. Either way, the AI review below decides.
        break;
      }

      const fillResult = await fillApplicationForm(formCtx, cand, resumeFilePath);
      attempt.formFieldsFilled = { ...fillResult, step };
      await addStep(attempt, "fill_form", "SUCCESS", `step=${step}, ATS=${fillResult.ats}, resumeAttached=${fillResult.resumeAttached}`);

      const submitButton = await findSubmitButton(formCtx);
      const nextButton = !submitButton ? await findNextButton(formCtx) : null;
      const control = submitButton ?? nextButton;

      if (!control) {
        await addStep(attempt, "form_dead_end", "FAILED", `No Submit or Next control found on step ${step}`);
        break;
      }

      await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }), control.click()]);
      await addStep(attempt, submitButton ? "submit" : "next_step", "SUCCESS", submitButton ? "Submit control clicked" : "Advanced to next step");

      const wallsAfterClick = await checkWalls(page, `step_${step}`);
      if (wallsAfterClick.blocked) {
        return await stopForHumanReview("step_wall", wallsAfterClick.attemptStatus!, wallsAfterClick.reason!, page);
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
      const judgment = await judgeApplicationScreenshot(finalProof.buffer, contextPrompt);
      let decision: ScreenshotDecision;
      let reasoning: string;
      if (judgment) {
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

      return { applicationId, status: "APPLIED" as const, proofUrl: finalProof.url };
    }

    if (finalStatus === "FAILED") {
      attempt.status = "FAILED";
      attempt.errorMessage = finalReason;
      attempt.finishedAt = new Date();
      await attempt.save();

      application.automationStatus = "FAILED";
      application.failureReason = finalReason;
      application.applicationProofScreenshot = finalProof.url;
      application.timeline.push({ status: application.status, note: `Automated apply failed after retries: ${finalReason}`, changedAt: new Date() });
      await application.save();

      if (cand.assignedRecruiterId) {
        await Task.create({
          assignedTo: cand.assignedRecruiterId,
          title: `Application failed after retries: ${cand.name} → ${jobDoc.title} @ ${jobDoc.company}`,
          description: `Automated apply retried ${MAX_AI_REVIEW_ATTEMPTS} times and could not get past: ${finalReason}. Review or complete manually: ${jobDoc.applicationUrl}`,
          entityType: "APPLICATION",
          entityId: app._id,
          priority: "HIGH",
          source: "AI_SUGGESTED",
          aiReasoning: finalReason,
        });
      }

      return { applicationId, status: "FAILED" as const, failureReason: finalReason };
    }

    return await stopForHumanReview("ai_needs_review", "NEEDS_REVIEW", finalReason, page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
    await closeApplySession(session);
  }
}
