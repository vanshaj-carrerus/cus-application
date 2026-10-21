import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { getCandidateMailbox, readMessage, translateGoogleError } from "@/lib/services/gmailMailbox";

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

// One full message (headers, HTML/text body, attachment list) from the candidate's own mailbox.
export const GET = withAuth(async (_req: NextRequest, { user, params }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;
  if (!/^[0-9a-f]{8,32}$/i.test(params.id ?? "")) return NextResponse.json({ error: "Invalid message id" }, { status: 400 });

  await connectDB();
  try {
    const { gmail } = await getCandidateMailbox(user.candidateId!);
    return NextResponse.json({ message: await readMessage(gmail, params.id) });
  } catch (err) {
    return translateGoogleError(err);
  }
});
