import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Client } from "@/lib/models/Client";

export const GET = withAuth(async () => {
  await connectDB();
  const clients = await Client.find({}).sort({ createdAt: -1 }).limit(100);
  return NextResponse.json({ clients });
}, "clients:read");

export const POST = withAuth(async (req: NextRequest) => {
  await connectDB();
  const body = await req.json();
  const client = await Client.create(body);
  return NextResponse.json({ client }, { status: 201 });
}, "clients:write");
