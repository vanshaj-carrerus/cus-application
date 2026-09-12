import { connectDB } from "@/lib/db/mongodb";
import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";
import { EmailThread } from "@/lib/models/EmailThread";
import { Application } from "@/lib/models/Application";

function encodeSubject(subject: string): string {
  // RFC 2047 encoded-word so non-ASCII subjects survive; ASCII subjects pass through fine too.
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildMimeMessage(params: { from: string; to: string; subject: string; html: string }): string {
  return [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodeSubject(params.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    params.html,
  ].join("\r\n");
}

export interface SendHrEmailParams {
  gmailAccountId: string;
  to: string;
  subject: string;
  html: string;
  candidateId?: string;
  jobId?: string;
  applicationId?: string;
  inReplyToThreadId?: string; // gmailThreadId, to reply within an existing thread
}

/**
 * Sends an email directly from a connected HR mailbox (From: is whatever Gmail
 * account was OAuth-connected — Gmail only lets you send as an address you actually
 * own/verified as a "Send As" alias on that account, so this can't spoof an arbitrary From).
 */
export async function sendHrEmail(params: SendHrEmailParams) {
  await connectDB();
  const { gmail, account } = await getAuthenticatedGmailClient(params.gmailAccountId);

  const raw = base64UrlEncode(buildMimeMessage({ from: account.emailAddress, to: params.to, subject: params.subject, html: params.html }));

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: params.inReplyToThreadId },
  });

  const gmailThreadId = res.data.threadId;
  const gmailMessageId = res.data.id;
  if (!gmailThreadId || !gmailMessageId) {
    throw new Error("Gmail send succeeded but did not return a threadId/messageId");
  }

  const thread = await EmailThread.findOneAndUpdate(
    { gmailAccountId: account._id, gmailThreadId },
    {
      $setOnInsert: {
        gmailAccountId: account._id,
        gmailThreadId,
        candidateId: params.candidateId,
        jobId: params.jobId,
        applicationId: params.applicationId,
        subject: params.subject,
        participants: [account.emailAddress, params.to],
        status: "OPEN",
      },
      $set: { lastMessageAt: new Date() },
      $push: {
        messages: {
          gmailMessageId,
          direction: "OUTBOUND",
          from: account.emailAddress,
          to: [params.to],
          subject: params.subject,
          bodyText: params.html,
          sentAt: new Date(),
        },
      },
    },
    { upsert: true, new: true }
  );

  if (params.applicationId) {
    await Application.updateOne(
      { _id: params.applicationId },
      { $push: { timeline: { note: `Email sent: "${params.subject}"`, changedAt: new Date() } } }
    );
  }

  return { gmailMessageId, gmailThreadId, emailThreadId: thread._id };
}
