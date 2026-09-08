export const ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "RECRUITER",
  "HIRING_MANAGER",
  "CANDIDATE",
  "CLIENT",
] as const;
export type Role = (typeof ROLES)[number];

export const JOB_STATUSES = ["ACTIVE", "PAUSED", "CLOSED", "EXPIRED", "DRAFT"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const REMOTE_TYPES = ["ONSITE", "REMOTE", "HYBRID", "UNKNOWN"] as const;
export type RemoteType = (typeof REMOTE_TYPES)[number];

export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACT",
  "INTERNSHIP",
  "TEMPORARY",
  "UNKNOWN",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const CANDIDATE_STATUSES = [
  "NEW",
  "ACTIVE",
  "PASSIVE",
  "IN_PROCESS",
  "PLACED",
  "DO_NOT_CONTACT",
  "ARCHIVED",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const APPLICATION_STATUSES = [
  "DRAFT",
  "PREPARING",
  "PENDING_APPROVAL",
  "APPROVED",
  "SUBMITTED",
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const AUTOMATION_STATUSES = [
  "NOT_QUEUED",
  "QUEUED",
  "IN_PROGRESS",
  "AWAITING_REVIEW",
  "SUBMITTED",
  "FAILED",
] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AI_ANALYSIS_TYPES = [
  "JOB_ANALYSIS",
  "CANDIDATE_ANALYSIS",
  "JOB_MATCH",
  "RESUME_ANALYSIS",
  "RESUME_TAILOR",
  "COVER_LETTER",
  "INTERVIEW_ANALYSIS",
  "JOB_DIFFICULTY",
  "CANDIDATE_INSIGHT",
  "CLIENT_INSIGHT",
] as const;
export type AiAnalysisType = (typeof AI_ANALYSIS_TYPES)[number];

export const AI_ANALYSIS_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type AiAnalysisStatus = (typeof AI_ANALYSIS_STATUSES)[number];

export const RECOMMENDATIONS = [
  "STRONGLY_RECOMMEND",
  "RECOMMEND",
  "REVIEW",
  "WEAK_MATCH",
  "DO_NOT_RECOMMEND",
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const JOB_DIFFICULTIES = ["EASY", "MODERATE", "DIFFICULT", "VERY_DIFFICULT"] as const;
export type JobDifficulty = (typeof JOB_DIFFICULTIES)[number];

export const NOTIFICATION_TYPES = [
  "JOB_MATCH",
  "APPLICATION_UPDATE",
  "INTERVIEW_REMINDER",
  "TASK_DUE",
  "SYSTEM",
  "AI_INSIGHT",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const AI_ACTIONS = [
  "AI_MATCH_CREATED",
  "AI_RESUME_GENERATED",
  "AI_COVER_LETTER_GENERATED",
  "AI_EMAIL_GENERATED",
  "AI_JOB_ANALYZED",
  "AI_CANDIDATE_ANALYZED",
  "AI_RESUME_ANALYZED",
  "AI_INTERVIEW_QUESTIONS_GENERATED",
  "AI_INTERVIEW_SUMMARIZED",
  "AI_SEARCH_PERFORMED",
  "AI_COPILOT_TOOL_CALL",
  "AI_JOB_DIFFICULTY_PREDICTED",
  "AI_NEXT_ACTION_SUGGESTED",
] as const;
export type AiActionType = (typeof AI_ACTIONS)[number];

// Permission matrix: which roles can perform which actions.
// Used by lib/auth/rbac.ts as the single source of truth.
export const PERMISSIONS = {
  "jobs:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER", "CLIENT"],
  "jobs:write": ["SUPER_ADMIN", "ADMIN", "RECRUITER"],
  "jobs:sync": ["SUPER_ADMIN", "ADMIN"],
  "candidates:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER"],
  "candidates:write": ["SUPER_ADMIN", "ADMIN", "RECRUITER"],
  "matching:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER"],
  "matching:write": ["SUPER_ADMIN", "ADMIN", "RECRUITER"],
  "applications:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER", "CLIENT", "CANDIDATE"],
  "applications:write": ["SUPER_ADMIN", "ADMIN", "RECRUITER"],
  "applications:approve": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER"],
  "resumes:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER"],
  "resumes:write": ["SUPER_ADMIN", "ADMIN", "RECRUITER"],
  "analytics:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER", "CLIENT"],
  "ai:copilot": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER"],
  "admin:manage": ["SUPER_ADMIN", "ADMIN"],
  "clients:read": ["SUPER_ADMIN", "ADMIN", "RECRUITER", "HIRING_MANAGER"],
  "clients:write": ["SUPER_ADMIN", "ADMIN"],
} as const;
export type Permission = keyof typeof PERMISSIONS;
