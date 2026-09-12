import { connectDB } from "@/lib/db/mongodb";
import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";
import { parseGmailMessage, extractEmailAddress } from "@/lib/services/gmailParser";
import { EmailThread } from "@/lib/models/EmailThread";
import { Candidate } from "@/lib/models/Candidate";
import { Application } from "@/lib/models/Application";

/**
 * Pulls everything new since the account's last known historyId (Gmail's push
 * notification only tells us "something changed" — this is what actually fetches
 * and records it). Called from the /api/webhooks/gmail push handler, and safe to
 * call again for the same account (messages are deduped by gmailMessageId).
 */
export async function syncGmailHistory(gmailAccountId: string): Promise<{ processed: number }> {
  await connectDB();
  const { gmail, account } = await getAuthenticatedGmailClient(gmailAccountId);

  if (!account.historyId) {
    const profile = await gmail.users.getProfile({ userId: "me" });
    account.historyId = profile.data.historyId ?? undefined;
    account.lastSyncedAt = new Date();
    await account.save();
    return { processed: 0 };
  }

  const messageIds: string[] = [];
  let latestHistoryId = account.historyId;

  try {
    let pageToken: string | undefined;
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId: account.historyId,
        historyTypes: ["messageAdded"],
        pageToken,
      });
      for (const record of res.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) messageIds.push(added.message.id);
        }
      }
      if (res.data.historyId) latestHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    // Gmail purges history after ~7 days; if our stored historyId is too old, Gmail
    // returns 404. Re-baseline from the current profile instead of failing forever.
    const status = (err as { code?: number; response?: { status?: number } })?.code ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      const profile = await gmail.users.getProfile({ userId: "me" });
      account.historyId = profile.data.historyId ?? undefined;
      account.lastError = "History window expired — resynced from current mailbox state";
      account.lastSyncedAt = new Date();
      await account.save();
      return { processed: 0 };
    }
    throw err;
  }

  let processed = 0;
  for (const messageId of messageIds) {
    const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const parsed = parseGmailMessage(full.data);
    if (!parsed.gmailThreadId) continue;

    const alreadyRecorded = await EmailThread.exists({
      gmailAccountId: account._id,
      gmailThreadId: parsed.gmailThreadId,
      "messages.gmailMessageId": parsed.gmailMessageId,
    });
    if (alreadyRecorded) continue;

    const fromAddress = extractEmailAddress(parsed.from);
    const direction: "OUTBOUND" | "INBOUND" = fromAddress === account.emailAddress.toLowerCase() ? "OUTBOUND" : "INBOUND";

    let thread = await EmailThread.findOne({ gmailAccountId: account._id, gmailThreadId: parsed.gmailThreadId });
    if (!thread) {
      const candidate = direction === "INBOUND" ? await Candidate.findOne({ email: fromAddress }) : null;
      thread = await EmailThread.create({
        gmailAccountId: account._id,
        gmailThreadId: parsed.gmailThreadId,
        candidateId: candidate?._id,
        subject: parsed.subject,
        participants: [parsed.from, ...parsed.to],
        status: direction === "INBOUND" ? "NEEDS_RESPONSE" : "OPEN",
        lastMessageAt: parsed.sentAt,
      });
    }

    thread.messages.push({
      gmailMessageId: parsed.gmailMessageId,
      direction,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      snippet: parsed.snippet,
      bodyText: parsed.bodyText,
      sentAt: parsed.sentAt,
    });
    thread.lastMessageAt = parsed.sentAt;
    if (direction === "INBOUND") thread.status = "NEEDS_RESPONSE";
    await thread.save();

    if (thread.applicationId) {
      await Application.updateOne(
        { _id: thread.applicationId },
        { $push: { timeline: { note: `${direction === "INBOUND" ? "Reply received" : "Email sent"}: "${parsed.subject}"`, changedAt: parsed.sentAt } } }
      );
    }

    processed++;
  }

  account.historyId = latestHistoryId;
  account.lastSyncedAt = new Date();
  await account.save();

  return { processed };
}
