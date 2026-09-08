import { connectDB } from "@/lib/db/mongodb";
import { Email } from "@/lib/models/Email";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";

export type EmailCategory =
  | "OUTREACH"
  | "INTERVIEW_INVITE"
  | "FOLLOW_UP"
  | "REJECTION"
  | "OFFER"
  | "APPLICATION_UPDATE"
  | "CLIENT_UPDATE";

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
};

export async function generateEmail(params: {
  category: EmailCategory;
  candidateId?: string;
  jobId?: string;
  applicationId?: string;
  tone?: "PROFESSIONAL" | "FRIENDLY" | "SHORT" | "FORMAL";
  extraContext?: string;
  userId?: string;
}) {
  await connectDB();
  const candidate = params.candidateId ? await Candidate.findById(params.candidateId) : null;
  const job = params.jobId ? await Job.findById(params.jobId) : null;
  const tone = params.tone ?? "PROFESSIONAL";

  const prompt = `Write a ${params.category.replace(/_/g, " ").toLowerCase()} email in a ${tone.toLowerCase()} tone.

${candidate ? `Candidate: ${candidate.name}` : ""}
${job ? `Job: ${job.title} at ${job.company}` : ""}
${params.extraContext ? `Additional context: ${params.extraContext}` : ""}

Only reference facts given above. Return a subject line and body. Do not use placeholder brackets.`;

  const result = await AiApiAdapter.structuredOutput<{ subject: string; body: string }>(prompt, {
    schema: EMAIL_SCHEMA,
    systemInstruction: "You are an expert recruitment communications writer.",
  });

  const email = await Email.create({
    fromUserId: params.userId,
    candidateId: params.candidateId,
    jobId: params.jobId,
    applicationId: params.applicationId,
    to: candidate?.email ?? "",
    subject: result.subject,
    body: result.body,
    tone,
    category: params.category,
    direction: "OUTBOUND",
    status: "DRAFT",
    aiGenerated: true,
  });

  await logAiAction({
    userId: params.userId,
    action: "AI_EMAIL_GENERATED",
    entityType: "Email",
    entityId: email._id,
    input: { category: params.category, candidateId: params.candidateId, jobId: params.jobId },
  });

  return email;
}
