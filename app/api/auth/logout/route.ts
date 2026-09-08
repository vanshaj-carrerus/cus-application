import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export async function POST() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(env.authCookieName, "", { path: "/", maxAge: 0 });
  return res;
}
