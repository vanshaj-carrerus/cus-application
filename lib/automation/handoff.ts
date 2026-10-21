import type { Types } from "mongoose";
import { Task } from "@/lib/models/Task";

/**
 * The task a recruiter picks up when the bot can't finish an application. One open task per application:
 * a second stop on the same application updates it instead of piling up duplicates.
 */
export async function upsertRecruiterTask(input: {
  assignedTo?: Types.ObjectId;
  applicationId: Types.ObjectId;
  candidateName: string;
  jobTitle: string;
  company: string;
  applicationUrl?: string;
  reason: string;
  kind: "MANUAL_APPLY" | "FAILED";
  resumeUrl?: string;
}): Promise<void> {
  if (!input.assignedTo) return;

  const title =
    input.kind === "FAILED"
      ? `Application failed after retries: ${input.candidateName} → ${input.jobTitle} @ ${input.company}`
      : `Manually complete application: ${input.candidateName} → ${input.jobTitle} @ ${input.company}`;
  const description = [
    `Automated apply stopped: ${input.reason}.`,
    input.applicationUrl ? `Finish this application by hand: ${input.applicationUrl}` : "",
    input.resumeUrl ? `Tailored resume for this job: ${input.resumeUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const open = await Task.findOne({ entityType: "APPLICATION", entityId: input.applicationId, source: "AI_SUGGESTED", status: { $in: ["OPEN", "IN_PROGRESS"] } });
  if (open) {
    open.title = title;
    open.description = description;
    open.aiReasoning = input.reason;
    await open.save();
    return;
  }

  await Task.create({
    assignedTo: input.assignedTo,
    title,
    description,
    entityType: "APPLICATION",
    entityId: input.applicationId,
    priority: "HIGH",
    source: "AI_SUGGESTED",
    aiReasoning: input.reason,
  });
}
