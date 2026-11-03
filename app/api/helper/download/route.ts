import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";

export const runtime = "nodejs";

/** The browser extension package, built by `npm run build:extension`. */
export const HELPER_ZIP = path.join(process.cwd(), "storage", "helper", "CUS-Assist-Extension.zip");

export const GET = withAuth(async () => {
  try {
    await stat(HELPER_ZIP);
  } catch {
    return NextResponse.json({ error: "The extension has not been built on this server yet. Ask whoever runs the server to run: npm run build:extension" }, { status: 404 });
  }
  const bytes = await readFile(HELPER_ZIP);
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="CUS-Assist-Extension.zip"', "Cache-Control": "no-store" },
  });
}, "assist:use");
