import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import type { Role } from "@/lib/models/enums";

export interface SessionPayload {
  sub: string; // user id
  email: string;
  role: Role;
  name: string;
  candidateId?: string; // present only when role === "CANDIDATE"
}

function secretKey() {
  return new TextEncoder().encode(env.authSecret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role, name: payload.name, candidateId: payload.candidateId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      role: payload.role as Role,
      name: payload.name as string,
      candidateId: payload.candidateId as string | undefined,
    };
  } catch {
    return null;
  }
}

/** Short-lived signed state for OAuth redirect flows (CSRF protection + carrying the initiating user id). */
export async function signOAuthState(userId: string, purpose: string): Promise<string> {
  return new SignJWT({ purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secretKey());
}

export async function verifyOAuthState(token: string, purpose: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (payload.purpose !== purpose || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
