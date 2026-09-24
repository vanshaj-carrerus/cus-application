import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { verifyOAuthState } from "@/lib/auth/session";
import { connectDB } from "@/lib/db/mongodb";
import { exchangeCodeForTokens } from "@/lib/services/googleAuth";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { encryptSecret } from "@/lib/security/crypto";
import { startGmailWatch } from "@/lib/services/gmailWatchService";

function redirectTo(req: NextRequest, path: string, status: "connected" | "error", message?: string) {
  const url = new URL(path, req.url);
  url.searchParams.set("gmail", status);
  if (message) url.searchParams.set("gmail_error", message);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  // Both the HR settings flow and the candidate portal flow redirect through this
  // same callback, since only one GOOGLE_REDIRECT_URI is registered with Google —
  // the signed state's purpose tells them apart.
  const isCandidateFlow = user.role === "CANDIDATE" && !!user.candidateId;
  const returnPath = isCandidateFlow ? "/portal/gmail" : "/settings";

  if (oauthError) return redirectTo(req, returnPath, "error", oauthError);
  if (!code || !state) return redirectTo(req, returnPath, "error", "missing_code_or_state");

  const stateUserId = await verifyOAuthState(state, isCandidateFlow ? "candidate_gmail_connect" : "gmail_connect");
  if (!stateUserId || stateUserId !== user.sub) {
    return redirectTo(req, returnPath, "error", "invalid_state");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await connectDB();

    const ownerType = isCandidateFlow ? "CANDIDATE" : "USER";
    const ownerId = isCandidateFlow ? user.candidateId! : user.sub;

    const account = await GmailAccount.findOneAndUpdate(
      { ownerType, ownerId },
      {
        ownerType,
        ownerId,
        emailAddress: tokens.emailAddress,
        accessTokenEncrypted: encryptSecret(tokens.accessToken),
        refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
        tokenExpiryDate: new Date(tokens.expiryDate),
        scope: tokens.scope,
        status: "CONNECTED",
        lastError: undefined,
      },
      { upsert: true, new: true }
    );

    try {
      await startGmailWatch(String(account._id));
    } catch (watchErr) {
      // Mailbox is connected and can send even if the push watch fails to register —
      // surface it but don't fail the whole connect flow over it.
      account.lastError = watchErr instanceof Error ? watchErr.message : "watch_setup_failed";
      await account.save();
    }

    return redirectTo(req, returnPath, "connected");
  } catch (err) {
    return redirectTo(req, returnPath, "error", err instanceof Error ? err.message : "unknown_error");
  }
}
