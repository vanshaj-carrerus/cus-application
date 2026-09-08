import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { hasPermission, ForbiddenError } from "@/lib/auth/rbac";
import type { Permission } from "@/lib/models/enums";
import type { SessionPayload } from "@/lib/auth/session";

type Handler = (req: NextRequest, ctx: { user: SessionPayload; params: Record<string, string> }) => Promise<Response>;

export function withAuth(handler: Handler, permission?: Permission) {
  return async (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => {
    try {
      const user = await getCurrentUser();
      if (!user) {
        return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      }
      if (permission && !hasPermission(user.role, permission)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const params = routeCtx?.params ? await routeCtx.params : {};
      return await handler(req, { user, params });
    } catch (err) {
      return errorToResponse(err);
    }
  };
}

export function errorToResponse(err: unknown): Response {
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  const status = (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : "Internal server error";
  if (status >= 500) {
    console.error(err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ error: message }, { status });
}
