import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/db/mongodb";
import { HelperToken } from "@/lib/models/HelperToken";
import { User } from "@/lib/models/User";
import { hasPermission } from "@/lib/auth/rbac";
import { errorToResponse } from "@/lib/api/handler";
import type { Permission, Role } from "@/lib/models/enums";

export const hashHelperToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface HelperUser {
  sub: string;
  role: Role;
  name: string;
}

type HelperHandler = (req: NextRequest, ctx: { user: HelperUser; params: Record<string, string> }) => Promise<Response>;

/** Like withAuth, but for the desktop helper: authenticates with `Authorization: Bearer <helper token>` instead of the login cookie. */
export function withHelperAuth(handler: HelperHandler, permission?: Permission) {
  return async (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => {
    try {
      const header = req.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) return NextResponse.json({ error: "Missing helper token" }, { status: 401 });

      await connectDB();
      const record = await HelperToken.findOne({ tokenHash: hashHelperToken(token), revokedAt: { $exists: false } });
      if (!record) return NextResponse.json({ error: "This helper is no longer connected. Click Connect helper in the portal." }, { status: 401 });
      const user = await User.findById(record.userId).select("name role isActive");
      if (!user || !user.isActive) return NextResponse.json({ error: "Account disabled" }, { status: 401 });
      if (permission && !hasPermission(user.role, permission)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      // Touch at most once a minute: a busy helper makes many calls per application.
      if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 60_000) await HelperToken.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });
      const params = routeCtx?.params ? await routeCtx.params : {};
      return await handler(req, { user: { sub: String(user._id), role: user.role, name: user.name }, params });
    } catch (err) {
      return errorToResponse(err);
    }
  };
}
