import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { sendHrEmail } from "@/lib/services/gmailSender";

/**
 * Some postings have no form at all — the page says "send your resume to careers@company.com". That is a
 * normal way to apply, and the candidate's own connected Gmail can do it: the same email a person would write,
 * with the tailored cover letter in the body and the tailored resume attached, sent from the candidate's address.
 *
 * Conservative on purpose — an email goes out under the candidate's name and cannot be taken back:
 *   - only an address the page itself ties to applying ("send your CV to …", "apply by email: …", a careers@ address);
 *   - never no-reply / support / privacy / press / sales / abuse / the candidate's own address;
 *   - only when the page has no form and no Apply control to use instead (the caller checks).
 */

export interface EmailApplyTarget {
  email: string;
  /** The sentence on the page that points at this address, kept for the recruiter's record. */
  evidence: string;
}

export async function findEmailApplyTarget(page: Page, ownEmails: string[] = []): Promise<EmailApplyTarget | null> {
  const found = await page
    .evaluate(() => {
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
      const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
      const INSTRUCTION = /(send|share|email|e-mail|mail|forward|submit|drop|reply|apply|attach).{0,90}(resume|résumé|cv|curriculum|application|profile|candidature)|(resume|résumé|cv|application|candidature)s?.{0,60}\b(to|at|on|via|:)\b|apply\s+(by|via|through)\s+e-?mail|e-?mail\s+(your|us|the)\b/i;
      const GOOD_LOCAL = /^(careers?|jobs?|hr|hiring|recruit(s|er|ers|ment|ing)?|talent|resumes?|cv|apply|applications?|join|work|people|staffing|opportunit(y|ies)|vacanc(y|ies))\b/i;

      const out: Array<{ email: string; evidence: string; mailto: boolean }> = [];
      const seen = new Set<string>();
      const add = (email: string, evidence: string, mailto: boolean) => {
        const key = email.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ email: key, evidence: evidence.replace(/\s+/g, " ").trim().slice(0, 220), mailto });
      };

      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='mailto:' i]"))) {
        const email = decodeURIComponent(a.getAttribute("href")!.slice(7).split("?")[0]).trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
        const block = a.closest("p, li, div, section, td") as HTMLElement | null;
        add(email, block?.innerText ?? a.innerText, true);
      }
      const bodyText = document.body?.innerText ?? "";
      for (const m of bodyText.matchAll(EMAIL)) {
        const i = m.index ?? 0;
        add(m[0], bodyText.slice(Math.max(0, i - 140), i + m[0].length + 60), false);
      }

      return out
        .map((c) => ({ ...c, good: GOOD_LOCAL.test(c.email.split("@")[0]), instructed: INSTRUCTION.test(c.evidence) }))
        .filter((c) => c.good || c.instructed)
        .sort((a, b) => Number(b.instructed && b.good) - Number(a.instructed && a.good) || Number(b.instructed) - Number(a.instructed))
        .slice(0, 3);
    })
    .catch(() => []);

  const BAD = /^(no-?reply|do-?not-?reply|donotreply|support|help|privacy|legal|press|media|sales|marketing|abuse|security|billing|webmaster|postmaster|admin|contact|info|hello|office)\b/i;
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  for (const candidate of found) {
    const local = candidate.email.split("@")[0];
    // "info@" / "contact@" are general-purpose; only trust them when the page explicitly points applicants there.
    if (BAD.test(local) && !(candidate.instructed && /resume|résumé|cv|apply|application/i.test(candidate.evidence))) continue;
    if (own.has(candidate.email)) continue;
    return { email: candidate.email, evidence: candidate.evidence };
  }
  return null;
}

export interface EmailApplyInput {
  candidateId: string;
  candidate: { name: string; email?: string; phone?: string };
  job: { _id: unknown; title: string; company: string };
  applicationId: string;
  to: string;
  coverLetter?: string;
  resumePath: string;
  resumeFilename?: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Builds and sends the application email from the candidate's own connected Gmail. Throws if none is connected. */
export async function sendApplicationEmail(input: EmailApplyInput): Promise<{ from: string; subject: string }> {
  const account = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: input.candidateId, status: { $ne: "DISCONNECTED" } });
  if (!account) throw new Error("this candidate has no connected Gmail to send the application from (Portal → Email Access)");

  const { name, phone } = input.candidate;
  const subject = `Application for ${input.job.title} — ${name}`;
  const letter = (input.coverLetter ?? "").trim();
  const looksHtml = /<(p|br|div|ul|li|strong)\b/i.test(letter);
  const body =
    letter.length > 40
      ? looksHtml
        ? letter
        : escapeHtml(letter).replace(/\n/g, "<br>")
      : `Hello,<br><br>I am writing to apply for the ${escapeHtml(input.job.title)} position at ${escapeHtml(input.job.company)}. My resume is attached, and I would welcome the chance to discuss how I can contribute.<br><br>Thank you for your time and consideration.`;
  const signature = `<br><br>Best regards,<br>${escapeHtml(name)}${phone ? `<br>${escapeHtml(phone)}` : ""}<br>${escapeHtml(account.emailAddress)}`;

  const data = await readFile(input.resumePath);
  const filename = input.resumeFilename ?? `${name.replace(/[^\w.-]+/g, "_")}_Resume${path.extname(input.resumePath) || ".pdf"}`;

  await sendHrEmail({
    gmailAccountId: String(account._id),
    to: input.to,
    subject,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${body}${signature}</div>`,
    candidateId: input.candidateId,
    jobId: String(input.job._id),
    applicationId: input.applicationId,
    attachments: [{ filename, mimeType: "application/pdf", data }],
  });
  return { from: account.emailAddress, subject };
}
