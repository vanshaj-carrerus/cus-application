import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { getAuthenticatedGmailClient } from "@/lib/services/googleAuth";
import { parseGmailMessage, extractEmailAddress } from "@/lib/services/gmailParser";

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

// Read-only sanity check for the candidate: proves the connected Gmail account can
// actually be read via the API by listing the 5 most recent inbox messages (subject
// line + sender + snippet only — never the full body).
export const GET = withAuth(async (_req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  await connectDB();
  const account = await GmailAccount.findOne({ ownerType: "CANDIDATE", ownerId: user.candidateId });
  if (!account) return NextResponse.json({ error: "Gmail not connected" }, { status: 404 });

  const { gmail } = await getAuthenticatedGmailClient(String(account._id));
  const list = await gmail.users.messages.list({ userId: "me", maxResults: 5, labelIds: ["INBOX"] });

  const messages = await Promise.all(
    (list.data.messages ?? []).map(async (m) => {
      const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
      const parsed = parseGmailMessage(full.data);
      return {
        id: parsed.gmailMessageId,
        from: extractEmailAddress(parsed.from),
        subject: parsed.subject || "(no subject)",
        snippet: parsed.snippet ?? "",
        sentAt: parsed.sentAt,
      };
    })
  );

  return NextResponse.json({ messages });
});
