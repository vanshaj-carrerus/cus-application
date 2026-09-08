import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { verifySession, type SessionPayload } from "./session";

export async function getCurrentUser(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(env.authCookieName)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function requireUser(): Promise<SessionPayload> {
  const user = await getCurrentUser();
  if (!user) {
    const err = new Error("Not authenticated");
    (err as { status?: number }).status = 401;
    throw err;
  }
  return user;
}
