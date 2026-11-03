import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { hashHelperToken } from "@/lib/api/helperAuth";
import { connectDB } from "@/lib/db/mongodb";
import { HelperToken } from "@/lib/models/HelperToken";

/**
 * "Connect helper": creates the token the desktop helper uses to act as this person. The portal page puts it in a
 * cusassist:// link that Windows hands to the installed helper; it is never shown or stored in readable form.
 * A person can be connected in several browsers at once (up to 5; the oldest connection is dropped after that).
 */
export const POST = withAuth(async (_req, { user }) => {
  await connectDB();
  const active = await HelperToken.find({ userId: user.sub, revokedAt: { $exists: false } }).sort({ createdAt: -1 }).select("_id");
  const surplus = active.slice(4).map((t) => t._id);
  if (surplus.length) await HelperToken.updateMany({ _id: { $in: surplus } }, { $set: { revokedAt: new Date() } });
  const token = randomBytes(32).toString("base64url");
  await HelperToken.create({ userId: user.sub, tokenHash: hashHelperToken(token), label: "Desktop helper" });
  return NextResponse.json({ token });
}, "assist:use");

/** Whether this person currently has a connected helper, and when it last checked in. */
export const GET = withAuth(async (_req, { user }) => {
  await connectDB();
  const active = await HelperToken.findOne({ userId: user.sub, revokedAt: { $exists: false } }).sort({ createdAt: -1 });
  return NextResponse.json({ connected: !!active, lastUsedAt: active?.lastUsedAt ?? null });
}, "assist:use");
