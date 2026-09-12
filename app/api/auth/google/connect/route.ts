import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { getGoogleAuthUrl } from "@/lib/services/googleAuth";
import { signOAuthState } from "@/lib/auth/session";

export const GET = withAuth(async (_req: NextRequest, { user }) => {
  const state = await signOAuthState(user.sub, "gmail_connect");
  return NextResponse.redirect(getGoogleAuthUrl(state));
}, "gmail:connect");
