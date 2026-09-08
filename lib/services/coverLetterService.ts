import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { Job } from "@/lib/models/Job";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";

export async function generateCoverLetter(
  candidateId: string,
  jobId: string,
  opts: { tone?: "PROFESSIONAL" | "FRIENDLY" | "SHORT" | "FORMAL"; userId?: string } = {}
) {
  await connectDB();
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate) throw new Error("Candidate not found");
  if (!job) throw new Error("Job not found");

  const tone = opts.tone ?? "PROFESSIONAL";

  const prompt = `Write a personalized cover letter for this candidate applying to this job. Tone: ${tone}. Use only truthful facts about the candidate below — never invent experience, companies, or skills.

Candidate: ${candidate.name}
Skills: ${candidate.skills.join(", ")}
Experience:
${candidate.experience.map((e) => `- ${e.title} at ${e.company}`).join("\n")}

Job: ${job.title} at ${job.company}
Key requirements: ${job.skills.join(", ")}
Job summary: ${job.aiAnalysis?.summary ?? job.description.slice(0, 500)}

Write 3-4 short paragraphs. Do not include placeholder brackets — use the real candidate and company names given.`;

  const coverLetter = await AiApiAdapter.generate(prompt, {
    systemInstruction: "You are an expert recruitment copywriter. You never fabricate candidate facts.",
    temperature: 0.5,
    maxOutputTokens: 1000,
  });

  await logAiAction({
    userId: opts.userId,
    action: "AI_COVER_LETTER_GENERATED",
    entityType: "Job",
    entityId: job._id,
    input: { candidateId, jobId, tone },
  });

  return coverLetter;
}
