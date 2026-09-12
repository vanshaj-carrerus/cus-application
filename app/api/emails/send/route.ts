import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { sendHrEmail } from "@/lib/services/gmailSender";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const body = (await req.json().catch(() => ({}))) as {
    to?: string;
    subject?: string;
    html?: string;
    candidateId?: string;
    jobId?: string;
    applicationId?: string;
  };
  if (!body.to || !body.subject || !body.html) {
    return NextResponse.json({ error: "to, subject, and html are required" }, { status: 400 });
  }

  await connectDB();
  const account = await GmailAccount.findOne({ ownerType: "USER", ownerId: user.sub, status: "CONNECTED" });
  if (!account) {
    return NextResponse.json({ error: "No connected Gmail account for this user — connect one at /api/auth/google/connect" }, { status: 400 });
  }

  const result = await sendHrEmail({
    gmailAccountId: String(account._id),
    to: body.to,
    subject: body.subject,
    html: body.html,
    candidateId: body.candidateId,
    jobId: body.jobId,
    applicationId: body.applicationId,
  });

  return NextResponse.json(result);
}, "gmail:send");
