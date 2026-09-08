import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { Notification } from "@/lib/models/Notification";

export const GET = withAuth(async (_req: NextRequest, { user }) => {
  await connectDB();
  const notifications = await Notification.find({ userId: user.sub }).sort({ createdAt: -1 }).limit(50);
  const unreadCount = await Notification.countDocuments({ userId: user.sub, isRead: false });
  return NextResponse.json({ notifications, unreadCount });
});

export const PATCH = withAuth(async (req: NextRequest, { user }) => {
  await connectDB();
  const { id, markAllRead } = (await req.json()) as { id?: string; markAllRead?: boolean };
  if (markAllRead) {
    await Notification.updateMany({ userId: user.sub, isRead: false }, { $set: { isRead: true } });
    return NextResponse.json({ success: true });
  }
  if (id) {
    await Notification.findOneAndUpdate({ _id: id, userId: user.sub }, { $set: { isRead: true } });
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "id or markAllRead is required" }, { status: 400 });
});
