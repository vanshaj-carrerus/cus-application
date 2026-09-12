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
import { detectAuthWall, detectSuccessConfirmation } from "@/lib/automation/pageState";
import { attemptAutoLogin } from "@/lib/automation/authLogin";
import { fillApplicationForm, findSubmitButton } from "@/lib/automation/formHeuristics";
import { captureProof } from "@/lib/automation/proof";
import type { Page } from "playwright";

const NAVIGATION_TIMEOUT_MS = 30_000;

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
 * Stage 3 of the auto-apply pipeline. Opens the job's apply page, fills what it can
 * recognize, attaches the tailored resume, and submits — unless a CAPTCHA is present,
 * in which case it stops and hands the application to a human (see lib/automation/captcha.ts
 * for why this never auto-solves).
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

  async function stopForHumanReview(stepName: string, attemptStatus: "BLOCKED_CAPTCHA" | "BLOCKED_LOGIN_REQUIRED", reason: string, page: Page) {
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
   * Checks for a login/account wall and, if the candidate has a matching saved
   * credential (see lib/automation/authLogin.ts), attempts to clear it automatically.
   * Only ever uses credentials the candidate explicitly registered themselves.
   */
  async function handleAuthWall(page: Page, stepName: string): Promise<{ outcome: "clear" | "logged_in" | "blocked"; reason?: string }> {
    if (!(await detectAuthWall(page))) {
      await addStep(attempt, stepName, "SUCCESS", "No login wall detected");
      return { outcome: "clear" };
    }

    const loginResult = await attemptAutoLogin(page, String(cand._id));
    if (loginResult.success) {
      await addStep(attempt, stepName, "SUCCESS", `Logged in automatically using saved ${loginResult.credentialLabel} credentials`);
      return { outcome: "logged_in" };
    }

    const reason = loginResult.attempted
      ? `Apply page requires sign-in — automated login with saved ${loginResult.credentialLabel} credentials failed`
      : "Apply page requires sign-in/account creation and no saved credentials match this site";
    await addStep(attempt, stepName, "FAILED", reason);
    return { outcome: "blocked", reason };
  }

  /** Fills the form and clicks submit; returns false if no submit control was found. */
  async function fillAndSubmit(page: Page): Promise<boolean> {
    const fillResult = await fillApplicationForm(page, cand, resumeFilePath);
    attempt.formFieldsFilled = { ...fillResult };
    await addStep(attempt, "fill_form", "SUCCESS", `ATS=${fillResult.ats}, resumeAttached=${fillResult.resumeAttached}`);

    const submitButton = await findSubmitButton(page);
    if (!submitButton) return false;

    await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }), submitButton.click()]);
    await addStep(attempt, "submit", "SUCCESS", "Submit control clicked");
    return true;
  }

  try {
    const page = await session.context.newPage();
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

    await page.goto(job.applicationUrl, { waitUntil: "domcontentloaded" });
    await addStep(attempt, "navigate", "SUCCESS", job.applicationUrl);

    if (await detectCaptcha(page)) {
      return await stopForHumanReview("captcha_check", "BLOCKED_CAPTCHA", "CAPTCHA challenge detected — auto-solving is intentionally not supported", page);
    }
    await addStep(attempt, "captcha_check", "SUCCESS", "No CAPTCHA detected");

    const initialWall = await handleAuthWall(page, "auth_wall_check");
    if (initialWall.outcome === "blocked") {
      return await stopForHumanReview("auth_wall_check", "BLOCKED_LOGIN_REQUIRED", initialWall.reason!, page);
    }
    if (initialWall.outcome === "logged_in") {
      // Login may have redirected elsewhere (e.g. a generic account dashboard) —
      // go back to the actual job posting before filling anything.
      await page.goto(job.applicationUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    let submitted = await fillAndSubmit(page);
    if (!submitted) {
      throw new Error("Could not locate a submit button on the application form");
    }

    // Clicking "submit" is not evidence anything was actually submitted — a login
    // wall can appear only at this step (some ATS flows defer it), and a silent
    // validation failure can leave the candidate on the same page. Verify before
    // claiming success; never assume it.
    const postSubmitWall = await handleAuthWall(page, "post_submit_auth_check");
    if (postSubmitWall.outcome === "blocked") {
      return await stopForHumanReview("post_submit_auth_check", "BLOCKED_LOGIN_REQUIRED", postSubmitWall.reason!, page);
    }
    if (postSubmitWall.outcome === "logged_in") {
      // The original submit didn't go through (it hit the wall instead) — the form
      // needs refilling and resubmitting now that we're past the login.
      await page.goto(job.applicationUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      submitted = await fillAndSubmit(page);
      if (!submitted) {
        throw new Error("Could not locate a submit button on the application form after logging in");
      }
    }

    const confirmed = await detectSuccessConfirmation(page);
    const proof = await captureProof(page, proofSubdir);
    await addStep(
      attempt,
      "capture_proof",
      confirmed ? "SUCCESS" : "FAILED",
      confirmed ? "Submission confirmation detected" : "No submission confirmation found after submit — not marking as applied",
      proof.url
    );

    if (!confirmed) {
      attempt.status = "NEEDS_REVIEW";
      attempt.finishedAt = new Date();
      await attempt.save();

      application.automationStatus = "AWAITING_REVIEW";
      application.applicationProofScreenshot = proof.url;
      application.timeline.push({
        status: application.status,
        note: "Automation could not confirm the application was submitted — needs manual verification",
        changedAt: new Date(),
      });
      await application.save();

      if (candidate.assignedRecruiterId) {
        await Task.create({
          assignedTo: candidate.assignedRecruiterId,
          title: `Verify application: ${candidate.name} → ${job.title} @ ${job.company}`,
          description: `Automation clicked submit but couldn't confirm the application actually went through. Check and complete manually if needed: ${job.applicationUrl}`,
          entityType: "APPLICATION",
          entityId: application._id,
          priority: "HIGH",
          source: "AI_SUGGESTED",
          aiReasoning: "No success confirmation (URL or page text) detected after clicking submit.",
        });
      }

      return { applicationId, status: "NEEDS_REVIEW" as const };
    }

    attempt.status = "SUCCESS";
    attempt.submissionConfirmation = { finalUrl: page.url() };
    attempt.finishedAt = new Date();
    await attempt.save();

    application.status = "APPLIED";
    application.automationStatus = "SUBMITTED";
    application.appliedAt = new Date();
    application.applicationProofScreenshot = proof.url;
    application.timeline.push({ status: "APPLIED", note: "Submitted via automated apply", changedAt: new Date() });
    await application.save();

    await AutoApplyProfile.updateOne({ candidateId: candidate._id }, { $inc: { appliedToday: 1 } });
    await persistSession(session);

    return { applicationId, status: "APPLIED" as const, proofUrl: proof.url };
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
