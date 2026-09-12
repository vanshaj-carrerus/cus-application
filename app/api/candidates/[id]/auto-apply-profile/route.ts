import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { AutoApplyProfile } from "@/lib/models/AutoApplyProfile";

export const GET = withAuth(async (_req: NextRequest, { params }) => {
  await connectDB();
  const profile = await AutoApplyProfile.findOne({ candidateId: params.id });
  return NextResponse.json({ profile });
}, "autoapply:manage");

export const PUT = withAuth(async (req: NextRequest, { params }) => {
  await connectDB();
  const body = await req.json();
  const profile = await AutoApplyProfile.findOneAndUpdate(
    { candidateId: params.id },
    {
      $set: {
        candidateId: params.id,
        enabled: Boolean(body.enabled),
        boards: body.boards ?? [],
        keywords: body.keywords ?? [],
        excludeKeywords: body.excludeKeywords ?? [],
        locations: body.locations ?? [],
        remotePreference: body.remotePreference ?? [],
        employmentTypes: body.employmentTypes ?? [],
        minSalary: body.minSalary ?? undefined,
        currency: body.currency ?? undefined,
        dailyApplyLimit: body.dailyApplyLimit ?? 10,
        mode: body.mode ?? "REVIEW_FIRST",
        requireCoverLetter: body.requireCoverLetter ?? true,
      },
    },
    { upsert: true, new: true }
  );
  return NextResponse.json({ profile });
}, "autoapply:manage");
