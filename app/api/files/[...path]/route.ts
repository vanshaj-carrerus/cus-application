import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { readStoredFile } from "@/lib/storage/fileStorage";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { path: segments } = await ctx.params;
  const key = segments.join("/");

  try {
    const buffer = await readStoredFile(key);
    const extension = key.split(".").pop() ?? "";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${key.split("/").pop()}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
