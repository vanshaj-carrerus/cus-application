import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { getCandidateMailbox, readAttachment, translateGoogleError } from "@/lib/services/gmailMailbox";

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

// Downloads one attachment. Always served as a download (never rendered inline on our origin),
// because an attachment is arbitrary content from whoever emailed the candidate.
export const GET = withAuth(async (_req: NextRequest, { user, params }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;
  if (!/^[0-9a-f]{8,32}$/i.test(params.id ?? "") || !/^[0-9.]{1,20}$/.test(params.partId ?? "")) {
    return NextResponse.json({ error: "Invalid attachment reference" }, { status: 400 });
  }

  await connectDB();
  try {
    const { gmail } = await getCandidateMailbox(user.candidateId!);
    const file = await readAttachment(gmail, params.id, params.partId);
    const safeName = file.filename.replace(/[\r\n"\\/]+/g, "_");
    return new Response(new Uint8Array(file.data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Content-Length": String(file.data.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return translateGoogleError(err);
  }
});
