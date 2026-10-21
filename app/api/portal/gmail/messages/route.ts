import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { getCandidateMailbox, isMailboxFolder, listMailbox, translateGoogleError } from "@/lib/services/gmailMailbox";

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

// The candidate browsing their own mailbox (folder list + search). Read-only, nothing stored.
export const GET = withAuth(async (req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  const folder = (req.nextUrl.searchParams.get("folder") ?? "INBOX").toUpperCase();
  if (!isMailboxFolder(folder)) return NextResponse.json({ error: "Unknown folder" }, { status: 400 });
  const q = req.nextUrl.searchParams.get("q")?.slice(0, 300);
  const pageToken = req.nextUrl.searchParams.get("pageToken")?.slice(0, 500);

  await connectDB();
  try {
    const { gmail } = await getCandidateMailbox(user.candidateId!);
    return NextResponse.json(await listMailbox(gmail, { folder, q, pageToken }));
  } catch (err) {
    return translateGoogleError(err);
  }
});
