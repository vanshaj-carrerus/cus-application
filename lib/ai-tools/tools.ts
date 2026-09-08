import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { Candidate } from "@/lib/models/Candidate";
import { Application } from "@/lib/models/Application";
import { Task } from "@/lib/models/Task";
import { Notification } from "@/lib/models/Notification";
import { matchCandidateToJob } from "@/lib/services/matchingService";
import { tailorResume } from "@/lib/services/resumeService";
import { generateCoverLetter } from "@/lib/services/coverLetterService";
import { generateInterviewQuestions } from "@/lib/services/interviewService";
import { naturalLanguageCandidateSearch, naturalLanguageJobSearch } from "@/lib/services/naturalLanguageSearchService";
import { hasPermission } from "@/lib/auth/rbac";
import type { Permission } from "@/lib/models/enums";
import type { Role } from "@/lib/models/enums";

/**
 * The Recruitment Copilot never touches MongoDB directly. It can only call these
 * pre-defined, permission-checked tools. Every call is logged via AiAction (see
 * lib/ai/log-action.ts, invoked inside each underlying service/tool).
 */

export interface ToolContext {
  userId: string;
  role: Role;
}

export interface ToolDefinition {
  name: string;
  description: string;
  permission: Permission;
  parameters: Record<string, unknown>; // JSON schema
  requiresApproval?: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "searchJobs",
    description: "Search jobs using a natural language query (e.g. 'remote senior react jobs').",
    permission: "jobs:read",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args) => {
      await connectDB();
      const { jobs, filters } = await naturalLanguageJobSearch(String(args.query));
      return { filters, jobs: jobs.map(summarizeJob) };
    },
  },
  {
    name: "getJob",
    description: "Get full details for one job by id.",
    permission: "jobs:read",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
    execute: async (args) => {
      await connectDB();
      const job = await Job.findById(String(args.jobId));
      if (!job) return { error: "Job not found" };
      return job.toObject();
    },
  },
  {
    name: "searchCandidates",
    description: "Search candidates using a natural language query (e.g. 'senior react developer in Ahmedabad with 5+ years').",
    permission: "candidates:read",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args) => {
      await connectDB();
      const { candidates, filters } = await naturalLanguageCandidateSearch(String(args.query));
      return { filters, candidates: candidates.map(summarizeCandidate) };
    },
  },
  {
    name: "getCandidate",
    description: "Get full details for one candidate by id.",
    permission: "candidates:read",
    parameters: { type: "object", properties: { candidateId: { type: "string" } }, required: ["candidateId"] },
    execute: async (args) => {
      await connectDB();
      const candidate = await Candidate.findById(String(args.candidateId));
      if (!candidate) return { error: "Candidate not found" };
      return candidate.toObject();
    },
  },
  {
    name: "matchCandidateToJob",
    description: "Run AI match analysis between a candidate and a job, returns score + explanation.",
    permission: "matching:write",
    parameters: {
      type: "object",
      properties: { candidateId: { type: "string" }, jobId: { type: "string" } },
      required: ["candidateId", "jobId"],
    },
    execute: async (args, ctx) => {
      const match = await matchCandidateToJob(String(args.candidateId), String(args.jobId), { userId: ctx.userId });
      return match.toObject();
    },
  },
  {
    name: "getApplications",
    description: "List applications, optionally filtered by candidateId, jobId, recruiterId, or status.",
    permission: "applications:read",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
        jobId: { type: "string" },
        recruiterId: { type: "string" },
        status: { type: "string" },
      },
    },
    execute: async (args) => {
      await connectDB();
      const filter: Record<string, unknown> = {};
      if (args.candidateId) filter.candidateId = args.candidateId;
      if (args.jobId) filter.jobId = args.jobId;
      if (args.recruiterId) filter.recruiterId = args.recruiterId;
      if (args.status) filter.status = args.status;
      const apps = await Application.find(filter).limit(50).sort({ updatedAt: -1 });
      return apps.map((a) => a.toObject());
    },
  },
  {
    name: "getRecruiterTasks",
    description: "List open tasks assigned to the current recruiter.",
    permission: "applications:read",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      await connectDB();
      const tasks = await Task.find({ assignedTo: ctx.userId, status: { $in: ["OPEN", "IN_PROGRESS"] } }).sort({ dueDate: 1 }).limit(50);
      return tasks.map((t) => t.toObject());
    },
  },
  {
    name: "createApplication",
    description: "Create a new draft application linking a candidate to a job. Does not submit it anywhere.",
    permission: "applications:write",
    parameters: {
      type: "object",
      properties: { candidateId: { type: "string" }, jobId: { type: "string" } },
      required: ["candidateId", "jobId"],
    },
    execute: async (args, ctx) => {
      await connectDB();
      const app = await Application.create({
        candidateId: String(args.candidateId),
        jobId: String(args.jobId),
        recruiterId: ctx.userId,
        status: "DRAFT",
        timeline: [{ status: "DRAFT", changedBy: ctx.userId, changedAt: new Date() }],
      });
      return app.toObject();
    },
  },
  {
    name: "generateResume",
    description: "Generate a tailored resume version for a candidate targeting a specific job. Never invents facts.",
    permission: "resumes:write",
    parameters: {
      type: "object",
      properties: { candidateId: { type: "string" }, jobId: { type: "string" } },
      required: ["candidateId", "jobId"],
    },
    execute: async (args, ctx) => {
      const resume = await tailorResume(String(args.candidateId), String(args.jobId), { userId: ctx.userId });
      return resume.toObject();
    },
  },
  {
    name: "generateCoverLetter",
    description: "Generate a personalized cover letter for a candidate applying to a job.",
    permission: "resumes:write",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
        jobId: { type: "string" },
        tone: { type: "string", enum: ["PROFESSIONAL", "FRIENDLY", "SHORT", "FORMAL"] },
      },
      required: ["candidateId", "jobId"],
    },
    execute: async (args, ctx) => {
      const coverLetter = await generateCoverLetter(String(args.candidateId), String(args.jobId), {
        tone: args.tone as "PROFESSIONAL" | "FRIENDLY" | "SHORT" | "FORMAL" | undefined,
        userId: ctx.userId,
      });
      return { coverLetter };
    },
  },
  {
    name: "createInterviewQuestions",
    description: "Generate an interview question set for a job, optionally personalized to a candidate.",
    permission: "candidates:read",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string" }, candidateId: { type: "string" } },
      required: ["jobId"],
    },
    execute: async (args, ctx) => {
      return generateInterviewQuestions(String(args.jobId), args.candidateId ? String(args.candidateId) : undefined, { userId: ctx.userId });
    },
  },
  {
    name: "updateApplicationStatus",
    description: "Change an application's status. High-impact action — requires explicit recruiter confirmation before executing.",
    permission: "applications:approve",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { applicationId: { type: "string" }, status: { type: "string" }, note: { type: "string" } },
      required: ["applicationId", "status"],
    },
    execute: async (args, ctx) => {
      await connectDB();
      const app = await Application.findById(String(args.applicationId));
      if (!app) return { error: "Application not found" };
      app.status = args.status as typeof app.status;
      app.timeline.push({ status: app.status, note: args.note as string | undefined, changedBy: ctx.userId as unknown as never, changedAt: new Date() });
      await app.save();
      return app.toObject();
    },
  },
  {
    name: "createNotification",
    description: "Create a notification for a user.",
    permission: "applications:write",
    parameters: {
      type: "object",
      properties: { userId: { type: "string" }, title: { type: "string" }, message: { type: "string" } },
      required: ["userId", "title", "message"],
    },
    execute: async (args) => {
      await connectDB();
      const notif = await Notification.create({
        userId: String(args.userId),
        type: "AI_INSIGHT",
        title: String(args.title),
        message: String(args.message),
      });
      return notif.toObject();
    },
  },
];

function summarizeJob(job: InstanceType<typeof Job>) {
  return {
    id: job._id,
    title: job.title,
    company: job.company,
    location: job.location,
    remoteType: job.remoteType,
    skills: job.skills,
    aiScore: job.aiScore,
    aiDifficulty: job.aiDifficulty,
  };
}

function summarizeCandidate(candidate: InstanceType<typeof Candidate>) {
  return {
    id: candidate._id,
    name: candidate.name,
    location: candidate.location,
    skills: candidate.skills,
    yearsOfExperience: candidate.yearsOfExperience,
    careerLevel: candidate.careerLevel,
    status: candidate.status,
  };
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function isToolAuthorized(tool: ToolDefinition, role: Role): boolean {
  return hasPermission(role, tool.permission);
}
