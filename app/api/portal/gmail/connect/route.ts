import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { getGoogleAuthUrl } from "@/lib/services/googleAuth";
import { signOAuthState } from "@/lib/auth/session";

// Candidates aren't in the "gmail:connect" permission (that's HR-only), so this
// checks role directly rather than passing a permission to withAuth — same pattern
// as app/api/portal/credentials/route.ts.
export const GET = withAuth(async (_req: NextRequest, { user }) => {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }

  const state = await signOAuthState(user.sub, "candidate_gmail_connect");
  return NextResponse.redirect(getGoogleAuthUrl(state));
});
