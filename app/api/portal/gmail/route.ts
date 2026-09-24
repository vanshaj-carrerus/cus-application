import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { stopGmailWatch } from "@/lib/services/gmailWatchService";

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

export const GET = withAuth(async (_req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  await connectDB();
  const account = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: user.candidateId }).select(
    "emailAddress status lastSyncedAt lastError createdAt"
  );

  if (!account) return NextResponse.json({ connected: false });
  return NextResponse.json({
    connected: account.status === "CONNECTED",
    emailAddress: account.emailAddress,
    status: account.status,
    lastSyncedAt: account.lastSyncedAt,
    lastError: account.lastError,
    connectedAt: account.createdAt,
  });
});

export const DELETE = withAuth(async (_req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  await connectDB();
  const account = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: user.candidateId });
  if (!account) return NextResponse.json({ disconnected: true });

  try {
    await stopGmailWatch(String(account._id));
  } catch (err) {
    // Revoking locally still removes our access even if the remote watch teardown fails.
    account.status = "DISCONNECTED";
    account.lastError = err instanceof Error ? err.message : "watch_stop_failed";
    await account.save();
  }

  return NextResponse.json({ disconnected: true });
});
