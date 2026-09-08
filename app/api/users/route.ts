import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { hashPassword } from "@/lib/auth/session";
import type { Role } from "@/lib/models/enums";

export const GET = withAuth(async (req: NextRequest) => {
  await connectDB();
  const role = req.nextUrl.searchParams.get("role");
  const filter: Record<string, unknown> = role ? { role } : {};
  const users = await User.find(filter).select("-passwordHash").sort({ createdAt: -1 });
  return NextResponse.json({ users });
}, "admin:manage");

export const POST = withAuth(async (req: NextRequest) => {
  await connectDB();
  const body = (await req.json()) as { name: string; email: string; password: string; role: string };
  if (!body.name || !body.email || !body.password || !body.role) {
    return NextResponse.json({ error: "name, email, password, and role are required" }, { status: 400 });
  }
  const passwordHash = await hashPassword(body.password);
  const user = await User.create({ name: body.name, email: body.email, passwordHash, role: body.role as Role });
  return NextResponse.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } }, { status: 201 });
}, "admin:manage");
