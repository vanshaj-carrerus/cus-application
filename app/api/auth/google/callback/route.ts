import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { verifyOAuthState } from "@/lib/auth/session";
import { connectDB } from "@/lib/db/mongodb";
import { exchangeCodeForTokens } from "@/lib/services/googleAuth";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { encryptSecret } from "@/lib/security/crypto";
import { startGmailWatch } from "@/lib/services/gmailWatchService";

function redirectToSettings(req: NextRequest, status: "connected" | "error", message?: string) {
  const url = new URL("/settings", req.url);
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

  if (oauthError) return redirectToSettings(req, "error", oauthError);
  if (!code || !state) return redirectToSettings(req, "error", "missing_code_or_state");

  const stateUserId = await verifyOAuthState(state, "gmail_connect");
  if (!stateUserId || stateUserId !== user.sub) {
    return redirectToSettings(req, "error", "invalid_state");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await connectDB();

    const account = await GmailAccount.findOneAndUpdate(
      { ownerType: "USER", ownerId: user.sub },
      {
        ownerType: "USER",
        ownerId: user.sub,
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

    return redirectToSettings(req, "connected");
  } catch (err) {
    return redirectToSettings(req, "error", err instanceof Error ? err.message : "unknown_error");
  }
}
