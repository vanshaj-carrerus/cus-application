import { google } from "googleapis";
import { env } from "@/lib/env";
import { GmailAccount } from "@/lib/models/GmailAccount";
import { encryptSecret, decryptSecret } from "@/lib/security/crypto";

/**
 * Google OAuth2 + authenticated Gmail client helpers. Tokens are read/written through
 * the GmailAccount model added in Stage 1 — there's no separate "UserHrOAuth"
 * collection, GmailAccount already covers that (ownerType/ownerId + encrypted
 * access/refresh tokens + Pub/Sub watch state).
 */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

export function createOAuthClient() {
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
}

/** Builds the consent URL an HR user is redirected to. `state` should carry the connecting user's id. */
export function getGoogleAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even on re-consent
    scope: GMAIL_SCOPES,
    state,
  });
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  scope: string;
  emailAddress: string;
}

/** Exchanges an OAuth code for tokens and resolves which mailbox was connected. */
export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
    throw new Error("Google did not return a full token set (missing refresh_token — was prompt=consent used?)");
  }

  client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  if (!profile.data.emailAddress) {
    throw new Error("Could not resolve the connected Gmail address");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    scope: tokens.scope ?? GMAIL_SCOPES.join(" "),
    emailAddress: profile.data.emailAddress,
  };
}

/**
 * Returns an authenticated Gmail API client for a stored account, auto-persisting
 * a refreshed access token back to Mongo when Google issues one.
 */
export async function getAuthenticatedGmailClient(gmailAccountId: string) {
  const account = await GmailAccount.findById(gmailAccountId).select("+accessTokenEncrypted +refreshTokenEncrypted");
  if (!account) throw new Error(`GmailAccount ${gmailAccountId} not found`);

  const client = createOAuthClient();
  client.setCredentials({
    access_token: decryptSecret(account.accessTokenEncrypted),
    refresh_token: decryptSecret(account.refreshTokenEncrypted),
    expiry_date: account.tokenExpiryDate.getTime(),
  });

  client.on("tokens", (tokens) => {
    const update: Record<string, unknown> = {};
    if (tokens.access_token) update.accessTokenEncrypted = encryptSecret(tokens.access_token);
    if (tokens.refresh_token) update.refreshTokenEncrypted = encryptSecret(tokens.refresh_token);
    if (tokens.expiry_date) update.tokenExpiryDate = new Date(tokens.expiry_date);
    if (Object.keys(update).length > 0) {
      GmailAccount.updateOne({ _id: account._id }, { $set: update }).catch((err) => {
        console.error(`[googleAuth] failed to persist refreshed token for ${account._id}:`, err);
      });
    }
  });

  return { gmail: google.gmail({ version: "v1", auth: client }), account };
}
