import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { naturalLanguageCandidateSearch, naturalLanguageJobSearch } from "@/lib/services/naturalLanguageSearchService";

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const { query, entity } = (await req.json()) as { query: string; entity: "candidates" | "jobs" };
  if (!query || !entity) return NextResponse.json({ error: "query and entity are required" }, { status: 400 });

  if (entity === "candidates") {
    const result = await naturalLanguageCandidateSearch(query, { userId: user.sub });
    return NextResponse.json(result);
  }
  const result = await naturalLanguageJobSearch(query, { userId: user.sub });
  return NextResponse.json(result);
}, "candidates:read");
