import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { User } from "@/lib/models/User";
import { hashPassword } from "@/lib/auth/session";

/**
 * Reports whether a CANDIDATE-role login already exists for this candidate.
 * Passwords are hashed on write and never stored in retrievable form, so this
 * only ever returns the login id / account metadata, never a password.
 */
export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const existing = await User.findOne({ candidateId: params.id, role: "CANDIDATE" });
  if (!existing) return NextResponse.json({ exists: false });
  return NextResponse.json({
    exists: true,
    loginId: existing.email,
    isActive: existing.isActive,
    lastLoginAt: existing.lastLoginAt,
    createdAt: existing.createdAt,
  });
}, "candidates:write");

/**
 * Recruiter-triggered: creates (or resets the password for) a CANDIDATE-role login
 * tied to this candidate record, so they can sign into their own portal. Both the
 * login id and password can be set explicitly by the recruiter, or left blank to
 * fall back to the candidate's on-file email / an auto-generated password. Either
 * way the plaintext password is returned once in the response to hand off directly —
 * there's no email-sending wired up for candidate onboarding yet.
 */
export const POST = withAuth(async (req: NextRequest, { params }) => {
  await connectDB();
  const candidate = await Candidate.findById(params.id);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { loginId?: string; password?: string };

  const loginId = (body.loginId?.trim() || candidate.email || "").toLowerCase();
  if (!loginId) {
    return NextResponse.json({ error: "No login ID given and candidate has no email on file — provide one." }, { status: 400 });
  }

  if (body.password && body.password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  const password = body.password || randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(password);

  const existing = await User.findOne({ candidateId: candidate._id, role: "CANDIDATE" });
  let user;
  if (existing) {
    if (loginId !== existing.email) {
      const idTaken = await User.findOne({ email: loginId, _id: { $ne: existing._id } });
      if (idTaken) return NextResponse.json({ error: `A user account already exists for ${loginId}` }, { status: 409 });
    }
    existing.passwordHash = passwordHash;
    existing.email = loginId;
    existing.name = candidate.name;
    existing.isActive = true;
    await existing.save();
    user = existing;
  } else {
    const idTaken = await User.findOne({ email: loginId });
    if (idTaken) {
      return NextResponse.json({ error: `A user account already exists for ${loginId}` }, { status: 409 });
    }
    user = await User.create({
      name: candidate.name,
      email: loginId,
      passwordHash,
      role: "CANDIDATE",
      candidateId: candidate._id,
    });
  }

  return NextResponse.json({ loginId: user.email, password, reset: !!existing });
}, "candidates:write");
