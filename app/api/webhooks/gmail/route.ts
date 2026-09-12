import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { connectDB } from "@/lib/db/mongodb";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { emailSyncQueue } from "@/lib/queue/queues";

interface PubSubPushBody {
  message?: { data?: string; messageId?: string; publishTime?: string };
  subscription?: string;
}

/**
 * Pub/Sub push endpoint for Gmail watch notifications. Configure the push subscription
 * with this URL plus ?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN> so we can reject
 * unauthenticated callers without needing full OIDC token verification.
 * Always acks fast (2xx) — the actual mailbox sync happens async on email-sync-queue,
 * since Pub/Sub retries (and can pile up duplicate pushes) if we don't respond quickly.
 */
export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("token") !== env.gmailPubsubVerificationToken) {
    return NextResponse.json({ error: "Invalid verification token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PubSubPushBody | null;
  const data = body?.message?.data;
  if (!data) {
    return NextResponse.json({ ok: true }); // ack malformed pushes rather than trigger retries
  }

  let payload: { emailAddress?: string; historyId?: string };
  try {
    payload = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));
  } catch {
    return NextResponse.json({ ok: true });
  }

  if (payload.emailAddress) {
    await connectDB();
    const account = await GmailAccount.findOne({ emailAddress: payload.emailAddress.toLowerCase() });
    if (account) {
      await emailSyncQueue().add("sync", { gmailAccountId: String(account._id) });
    }
  }

  return NextResponse.json({ ok: true });
}
