import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { getCommandCenter } from "@/lib/services/dashboardService";

export const GET = withAuth(async (_req, { user }) => {
  const data = await getCommandCenter(user.sub, user.role);
  return NextResponse.json(data);
});
