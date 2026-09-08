import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { AiApiAdapter } from "@/lib/adapters/aiApiAdapter";
import { logAiAction } from "@/lib/ai/log-action";

export async function extractTextFromFile(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  throw new Error(`Unsupported resume file type: ${mimeType}`);
}

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    location: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    technicalSkills: { type: "array", items: { type: "string" } },
    softSkills: { type: "array", items: { type: "string" } },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
          isCurrent: { type: "boolean" },
          description: { type: "string" },
        },
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          field: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
        },
      },
    },
    certifications: { type: "array", items: { type: "string" } },
    projects: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } } } },
    industries: { type: "array", items: { type: "string" } },
    yearsOfExperience: { type: "number" },
    noticePeriod: { type: "string" },
    expectedSalary: { type: "number" },
    preferredLocations: { type: "array", items: { type: "string" } },
    preferredRoles: { type: "array", items: { type: "string" } },
  },
  required: ["name", "skills", "experience", "education"],
};

export interface ParsedResumeProfile {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  skills: string[];
  technicalSkills: string[];
  softSkills: string[];
  experience: { title: string; company: string; startDate?: string; endDate?: string; isCurrent?: boolean; description?: string }[];
  education: { institution: string; degree?: string; field?: string; startDate?: string; endDate?: string }[];
  certifications: string[];
  projects: { name: string; description?: string }[];
  industries: string[];
  yearsOfExperience?: number;
  noticePeriod?: string;
  expectedSalary?: number;
  preferredLocations: string[];
  preferredRoles: string[];
}

export async function parseResumeText(resumeText: string): Promise<ParsedResumeProfile> {
  const prompt = `Extract a structured candidate profile from this resume text. Only extract information that is explicitly present — do not invent, guess, or embellish anything. Leave fields empty/omitted if not present.

Resume text:
${resumeText.slice(0, 10000)}`;

  return AiApiAdapter.structuredOutput<ParsedResumeProfile>(prompt, {
    schema: PARSE_SCHEMA,
    systemInstruction: "You are a precise resume parser. You extract only facts explicitly present in the text. You never invent information.",
  });
}

export async function createCandidateFromResume(params: {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  fileUrl: string;
  assignedRecruiterId?: string;
  userId?: string;
}) {
  await connectDB();
  const text = await extractTextFromFile(params.buffer, params.mimeType);
  const parsed = await parseResumeText(text);

  const candidate = await Candidate.create({
    name: parsed.name,
    email: parsed.email,
    phone: parsed.phone,
    location: parsed.location,
    skills: parsed.skills,
    technicalSkills: parsed.technicalSkills,
    softSkills: parsed.softSkills,
    experience: parsed.experience,
    education: parsed.education,
    certifications: parsed.certifications,
    projects: parsed.projects,
    industries: parsed.industries,
    yearsOfExperience: parsed.yearsOfExperience,
    noticePeriod: parsed.noticePeriod,
    expectedSalary: parsed.expectedSalary,
    preferredLocations: parsed.preferredLocations,
    preferredRoles: parsed.preferredRoles,
    resumeText: text,
    resumeFiles: [{ url: params.fileUrl, filename: params.filename, uploadedAt: new Date() }],
    assignedRecruiterId: params.assignedRecruiterId,
    status: "NEW",
    source: "RESUME_UPLOAD",
  });

  await logAiAction({
    userId: params.userId,
    action: "AI_CANDIDATE_ANALYZED",
    tool: "resumeParsing",
    entityType: "Candidate",
    entityId: candidate._id,
  });

  return candidate;
}
