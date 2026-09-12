import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { User } from "@/lib/models/User";
import { hashPassword } from "@/lib/auth/session";

/**
 * Recruiter-triggered: creates (or resets the password for) a CANDIDATE-role login
 * tied to this candidate record, so they can sign into their own portal. The temp
 * password is returned once in the response for the recruiter to hand off directly —
 * there's no email-sending wired up for candidate onboarding yet.
 */
export const POST = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const candidate = await Candidate.findById(params.id);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  if (!candidate.email) return NextResponse.json({ error: "Candidate has no email on file — add one before granting portal access" }, { status: 400 });

  const tempPassword = randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(tempPassword);

  const existing = await User.findOne({ candidateId: candidate._id, role: "CANDIDATE" });
  let user;
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.email = candidate.email;
    existing.name = candidate.name;
    existing.isActive = true;
    await existing.save();
    user = existing;
  } else {
    const emailTaken = await User.findOne({ email: candidate.email });
    if (emailTaken) {
      return NextResponse.json({ error: `A user account already exists for ${candidate.email}` }, { status: 409 });
    }
    user = await User.create({
      name: candidate.name,
      email: candidate.email,
      passwordHash,
      role: "CANDIDATE",
      candidateId: candidate._id,
    });
  }

  return NextResponse.json({ email: user.email, tempPassword, reset: !!existing });
}, "candidates:write");
