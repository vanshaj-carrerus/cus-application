import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { createCandidateFromResume } from "@/lib/services/resumeParsingService";
import { analyzeCandidate } from "@/lib/services/candidateAnalysisService";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const formData = await req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A resume file is required" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Unsupported file type. Upload a PDF or DOCX." }, { status: 400 });
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: "File too large (max 5MB)." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // NOTE: file storage is a local placeholder for now — swap for S3/Blob storage in production.
  const fileUrl = `local://resumes/${Date.now()}-${file.name}`;

  const candidate = await createCandidateFromResume({
    buffer,
    mimeType: file.type,
    filename: file.name,
    fileUrl,
    assignedRecruiterId: user.sub,
    userId: user.sub,
  });

  // AI candidate intelligence (headline, best-fit roles, strengths/gaps) runs
  // automatically right after parsing — no manual "Analyze" click needed.
  // A transient AI failure must never block candidate creation, so this is best-effort.
  try {
    await analyzeCandidate(String(candidate._id), { userId: user.sub });
  } catch (err) {
    console.error(`Auto-analysis failed for candidate ${candidate._id}:`, err);
  }

  await connectDB();
  const withProfile = await Candidate.findById(candidate._id);
  return NextResponse.json({ candidate: withProfile }, { status: 201 });
}, "candidates:write");
