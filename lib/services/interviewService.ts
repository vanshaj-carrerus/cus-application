import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { Candidate } from "@/lib/models/Candidate";
import { Interview } from "@/lib/models/Interview";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["Technical", "Behavioral", "Role-specific", "Experience", "Follow-up"] },
          question: { type: "string" },
        },
        required: ["category", "question"],
      },
    },
    evaluationCriteria: { type: "array", items: { type: "string" } },
  },
  required: ["questions", "evaluationCriteria"],
};

interface QuestionsResult {
  questions: { category: string; question: string }[];
  evaluationCriteria: string[];
}

export async function generateInterviewQuestions(jobId: string, candidateId?: string, opts: { userId?: string } = {}) {
  await connectDB();
  const job = await Job.findById(jobId);
  if (!job) throw new Error("Job not found");
  const candidate = candidateId ? await Candidate.findById(candidateId) : null;

  const prompt = `Generate an interview question set for this job${candidate ? ", personalized to this specific candidate's background" : ""}.

Job: ${job.title} at ${job.company}
Requirements: ${job.skills.join(", ")}
Responsibilities: ${job.responsibilities.join("; ")}

${candidate ? `Candidate background (use this to write personalized follow-up questions that probe specific claims in their experience):\n${candidate.experience.map((e) => `- ${e.title} at ${e.company}: ${e.description ?? ""}`).join("\n")}` : ""}

Generate a mix of Technical, Behavioral, Role-specific, Experience, and Follow-up questions (12-16 total), plus a short list of evaluationCriteria a recruiter should score answers against.`;

  const result = await AiApiAdapter.structuredOutput<QuestionsResult>(prompt, {
    schema: QUESTIONS_SCHEMA,
    systemInstruction: "You are an expert technical interviewer.",
  });

  await logAiAction({
    userId: opts.userId,
    action: "AI_INTERVIEW_QUESTIONS_GENERATED",
    entityType: "Job",
    entityId: job._id,
    input: { candidateId },
  });

  return result;
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
    candidateQuestions: { type: "array", items: { type: "string" } },
    recommendedNextStep: { type: "string" },
  },
  required: ["summary", "recommendedNextStep"],
};

export async function summarizeInterview(interviewId: string, notes: string, opts: { userId?: string } = {}) {
  await connectDB();
  const interview = await Interview.findById(interviewId);
  if (!interview) throw new Error("Interview not found");

  const prompt = `Summarize these interview notes for a recruiter. Only use what's in the notes — do not invent details.

Notes:
${notes}

Produce: summary, strengths, weaknesses, concerns, candidateQuestions (questions the candidate asked, if any), and recommendedNextStep (e.g. "Advance to technical round", "Reject", "Request follow-up"). This is a recommendation only — a human recruiter makes the final decision.`;

  const result = await AiApiAdapter.structuredOutput<{
    summary: string;
    strengths: string[];
    weaknesses: string[];
    concerns: string[];
    candidateQuestions: string[];
    recommendedNextStep: string;
  }>(prompt, { schema: SUMMARY_SCHEMA });

  interview.notes = notes;
  interview.aiSummary = { ...result, generatedAt: new Date() };
  await interview.save();

  await logAiAction({
    userId: opts.userId,
    action: "AI_INTERVIEW_SUMMARIZED",
    entityType: "Interview",
    entityId: interview._id,
  });

  return result;
}
