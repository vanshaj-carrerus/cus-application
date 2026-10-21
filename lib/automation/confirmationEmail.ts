import { Application } from "@/lib/models/Application";
import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { Job } from "@/lib/models/Job";
import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";
import { extractEmailAddress, parseGmailMessage } from "@/lib/services/gmailParser";
import { classifyHost } from "@/lib/automation/hostPolicy";

/**
 * A second, independent signal that an application really went through: the "thanks for applying" email the
 * employer or its ATS sends to the candidate. The bot already reads the candidate's connected Gmail for codes, so
 * it can look for this too — which catches an "applied" mark that was only the AI misreading a page.
 *
 * Deliberately strict. A message counts only if ALL hold:
 *   1. it says the application was received/submitted,
 *   2. it is not a look-alike (job alerts, "finish your application" reminders, verification codes),
 *   3. it is about THIS job: from the employer's/ATS's own domain, or naming the company or the job title.
 * Many employers send no confirmation at all, so "not found" never downgrades an application.
 */

const CONFIRMS =
  /(thank(s| you) for (applying|your (application|interest in)|submitting (your )?application)|(we('ve| have)|has been) received your (application|resume|cv)|your application (to|for|with|has been|was|is) (received|submitted|sent|complete)|application (received|submitted|confirmation)|successfully (applied|submitted)|you('ve| have) (successfully )?applied|we received your (application|resume|cv)|thank you for your application|merci pour votre candidature|votre candidature a (bien )?été)/i;

const LOOKALIKE =
  /(job alerts?|jobs? (you may|matching|for you)|recommended jobs|new jobs? (for|in|matching)|similar jobs|complete your application|finish your application|continue your application|your application is incomplete|verify your email|verification code|security code|one-time|password reset|reset your password|resume (tips|review|builder)|unsubscribe from job)/i;

/** Mail domains the big ATS platforms send confirmations from (they are not the employer's own domain). */
const ATS_MAIL_DOMAINS = [
  "greenhouse-mail.io",
  "greenhouse.io",
  "lever.co",
  "hire.lever.co",
  "myworkday.com",
  "myworkdayjobs.com",
  "ashbyhq.com",
  "workablemail.com",
  "workable.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "bamboohr.com",
  "recruitee.com",
  "teamtailor.com",
  "breezy.hr",
  "taleo.net",
  "oraclecloud.com",
  "successfactors.com",
  "mail.shine.com",
  "shine.com",
  "naukri.com",
  "foundit.in",
  "indeed.com",
  "linkedin.com",
];

const registrable = (host: string) => {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  return parts.slice(last.length === 2 && ["co", "com", "org", "net", "ac", "gov"].includes(second) ? -3 : -2).join(".");
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const STOP = new Set(["the", "and", "for", "inc", "llc", "ltd", "pvt", "private", "limited", "corp", "corporation", "company", "co", "group", "services", "solutions", "technologies", "technology", "senior", "junior", "lead", "developer", "engineer", "specialist", "manager"]);

export interface ConfirmationTarget {
  company: string;
  jobTitle: string;
  /** Hostname of the application URL. */
  jobHost: string;
}

export interface MailLike {
  from: string;
  subject: string;
  bodyText: string;
  sentAt: Date;
}

export type Verdict = { confirmed: true; why: string } | { confirmed: false; why: string };

/** Pure: does this message confirm an application to this job? */
export function judgeConfirmationEmail(mail: MailLike, target: ConfirmationTarget): Verdict {
  const body = mail.bodyText.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/gi, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const text = `${mail.subject}\n${body.slice(0, 2500)}`;

  if (LOOKALIKE.test(mail.subject) || (LOOKALIKE.test(text) && !CONFIRMS.test(mail.subject))) return { confirmed: false, why: "looks like an alert, reminder or verification message" };
  if (!CONFIRMS.test(text)) return { confirmed: false, why: "does not say an application was received" };

  const fromAddress = extractEmailAddress(mail.from);
  const fromDomain = registrable(fromAddress.split("@")[1] ?? "");
  const jobDomain = registrable(target.jobHost);
  const atsDomain = ATS_MAIL_DOMAINS.find((d) => fromDomain === registrable(d));
  // The employer's OWN domain is proof by itself. A domain shared by many employers (an ATS or job board) is
  // not: Ashby or Shine send confirmations for thousands of companies, so those must also name this one.
  if (fromDomain && jobDomain && fromDomain === jobDomain && !atsDomain) return { confirmed: true, why: `sent by ${fromDomain}, the employer's own site` };
  const companyWords = words(target.company).filter((w) => w.length >= 3 && !STOP.has(w));
  const lowerText = text.toLowerCase();
  const namesCompany = companyWords.length > 0 && companyWords.every((w) => lowerText.includes(w));
  const titleWords = [...new Set(words(target.jobTitle).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const titleHits = titleWords.filter((w) => lowerText.includes(w)).length;
  const namesTitle = titleWords.length >= 2 && titleHits >= Math.min(2, titleWords.length) && titleHits / titleWords.length >= 0.6;

  if (namesCompany) return { confirmed: true, why: `names ${target.company}${atsDomain ? ` (sent via ${atsDomain})` : ""}` };
  if (atsDomain && namesTitle) return { confirmed: true, why: `sent via ${atsDomain} and names the job title` };
  return { confirmed: false, why: "a confirmation, but not clearly about this job or company" };
}

export interface FoundConfirmation {
  from: string;
  subject: string;
  at: Date;
  why: string;
}

/** Searches the candidate's Gmail (read-only) for the confirmation, from a couple of minutes before submission onward. */
export async function findConfirmationEmail(gmailAccountId: string, target: ConfirmationTarget, since: Date): Promise<FoundConfirmation | null> {
  const { gmail } = await getAuthenticatedGmailClient(gmailAccountId);
  const after = Math.floor((since.getTime() - 2 * 60_000) / 1000);
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `after:${after} (application OR applying OR applied OR candidature OR "thank you" OR received)`,
    maxResults: 25,
    includeSpamTrash: true, // ATS mail from a new sender sometimes lands in spam
  });

  for (const { id } of list.data.messages ?? []) {
    if (!id) continue;
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" }).catch(() => null);
    if (!full?.data) continue;
    const parsed = parseGmailMessage(full.data);
    if (parsed.sentAt.getTime() < since.getTime() - 2 * 60_000) continue;
    const verdict = judgeConfirmationEmail({ from: parsed.from, subject: parsed.subject, bodyText: parsed.bodyText, sentAt: parsed.sentAt }, target);
    if (verdict.confirmed) return { from: extractEmailAddress(parsed.from), subject: parsed.subject, at: parsed.sentAt, why: verdict.why };
  }
  return null;
}

export class ConfirmationNotYet extends Error {
  constructor() {
    super("no confirmation email yet");
  }
}

/**
 * The queued check for one submitted application. Throws ConfirmationNotYet until the last scheduled try so the
 * queue retries later; on the last try it records "not found" without changing the application's status.
 */
export async function checkApplicationConfirmation(applicationId: string, isLastTry: boolean): Promise<{ result: "confirmed" | "not_found" | "no_mailbox" | "skipped"; detail?: string }> {
  const application = await Application.findById(applicationId);
  if (!application || application.automationStatus !== "SUBMITTED") return { result: "skipped", detail: "application is not in a submitted state" };

  const attempt = await ApplicationAttempt.findOne({ applicationId, status: "SUCCESS" }).sort({ finishedAt: -1 });
  if (!attempt) return { result: "skipped", detail: "no successful attempt on record" };
  if ((attempt.submissionConfirmation as { emailConfirmed?: boolean } | undefined)?.emailConfirmed === true) return { result: "confirmed", detail: "already confirmed" };

  const job = await Job.findById(application.jobId).select("title company applicationUrl");
  if (!job) return { result: "skipped", detail: "job no longer exists" };

  const mailbox = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: application.candidateId, status: { $ne: "DISCONNECTED" } });
  if (!mailbox) {
    await ApplicationAttempt.updateOne({ _id: attempt._id }, { $set: { "submissionConfirmation.emailConfirmed": null, "submissionConfirmation.emailCheck": "no connected Gmail to check" } });
    return { result: "no_mailbox" };
  }

  const found = await findConfirmationEmail(String(mailbox._id), { company: job.company, jobTitle: job.title, jobHost: classifyHost(job.applicationUrl ?? "").host }, attempt.finishedAt ?? attempt.startedAt);
  if (found) {
    await ApplicationAttempt.updateOne(
      { _id: attempt._id },
      { $set: { "submissionConfirmation.emailConfirmed": true, "submissionConfirmation.emailFrom": found.from, "submissionConfirmation.emailSubject": found.subject, "submissionConfirmation.emailAt": found.at, "submissionConfirmation.emailCheck": found.why } }
    );
    await Application.updateOne({ _id: applicationId }, { $push: { timeline: { status: application.status, note: `Confirmed: the employer's confirmation email arrived ("${found.subject.slice(0, 90)}" from ${found.from})`, changedAt: new Date() } } });
    return { result: "confirmed", detail: found.why };
  }

  if (!isLastTry) throw new ConfirmationNotYet();

  await ApplicationAttempt.updateOne({ _id: attempt._id }, { $set: { "submissionConfirmation.emailConfirmed": false, "submissionConfirmation.emailCheck": "no confirmation email found in the candidate's mailbox" } });
  await Application.updateOne({ _id: applicationId }, { $push: { timeline: { status: application.status, note: "No confirmation email found in the candidate's Gmail — many employers don't send one, but worth a glance at the proof screenshot", changedAt: new Date() } } });
  return { result: "not_found" };
}
