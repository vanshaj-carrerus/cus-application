import { env } from "@/lib/env";
import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";

/**
 * Registers (or renews) the Gmail Pub/Sub watch for an account so inbound mail
 * triggers a push to /api/webhooks/gmail. Watches expire after ~7 days per Gmail's
 * API limits, so this needs to be called again before `watchExpiration` — there's
 * no scheduler wired up yet (flagged separately), call this manually or from a cron
 * job you add later.
 */
export async function startGmailWatch(gmailAccountId: string) {
  const { gmail, account } = await getAuthenticatedGmailClient(gmailAccountId);

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: { topicName: env.gmailPubsubTopic, labelIds: ["INBOX"] },
  });

  account.historyId = res.data.historyId ?? account.historyId;
  account.watchExpiration = res.data.expiration ? new Date(Number(res.data.expiration)) : undefined;
  account.status = "CONNECTED";
  account.lastError = undefined;
  await account.save();

  return { historyId: account.historyId, watchExpiration: account.watchExpiration };
}

export async function stopGmailWatch(gmailAccountId: string) {
  const { gmail, account } = await getAuthenticatedGmailClient(gmailAccountId);
  await gmail.users.stop({ userId: "me" });
  account.status = "DISCONNECTED";
  await account.save();
}
