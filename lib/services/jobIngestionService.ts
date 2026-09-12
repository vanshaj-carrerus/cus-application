import { connectDB } from "@/lib/db/mongodb";
import { Job, type IJob } from "@/lib/models/Job";
import { Candidate } from "@/lib/models/Candidate";
import { Application } from "@/lib/models/Application";
import { AutoApplyProfile, type IAutoApplyProfile } from "@/lib/models/AutoApplyProfile";
import { SyncLog } from "@/lib/models/SyncLog";
import { JobApiAdapter, type RawJSearchJob } from "@/lib/adapters/jobApiAdapter";
import { resumeTailorQueue } from "@/lib/queue/queues";

/**
 * Stage 1 of the auto-apply pipeline: fetch candidate jobs matches from JSearch,
 * dedupe/filter them, persist as Job docs, then stub out an Application per
 * (candidate, job) pair with status PENDING_MATCHING and hand off to the
 * resume-tailor queue. This is separate from the recruiter-facing jobSyncService,
 * which only ingests jobs — it never creates Applications on a candidate's behalf.
 */

export interface IngestResult {
  profileId: string;
  fetched: number;
  jobsCreated: number;
  jobsSkippedFilter: number;
  jobsInvalid: number;
  applicationsCreated: number;
  applicationsSkippedExisting: number;
  applicationsSkippedNoRecruiter: number;
  applicationsSkippedDailyLimit: number;
}

function buildQuery(profile: IAutoApplyProfile): string {
  const role = profile.keywords.join(" ");
  const location = profile.locations[0];
  return location ? `${role} in ${location}` : role;
}

function passesFilters(job: Partial<IJob>, profile: IAutoApplyProfile): boolean {
  const haystack = `${job.title ?? ""} ${job.description ?? ""}`.toLowerCase();

  if (profile.excludeKeywords.some((kw) => kw && haystack.includes(kw.toLowerCase()))) {
    return false;
  }

  if (profile.remotePreference.length > 0 && job.remoteType && !profile.remotePreference.includes(job.remoteType)) {
    return false;
  }

  if (profile.employmentTypes.length > 0 && job.employmentType && !profile.employmentTypes.includes(job.employmentType)) {
    return false;
  }

  if (profile.minSalary && job.salaryMax !== undefined && job.salaryMax !== null && job.salaryMax < profile.minSalary) {
    return false;
  }

  if (profile.locations.length > 0 && job.remoteType !== "REMOTE") {
    const jobLocation = `${job.city ?? ""} ${job.state ?? ""} ${job.location ?? ""}`.toLowerCase();
    const matchesLocation = profile.locations.some((loc) => jobLocation.includes(loc.toLowerCase()));
    if (!matchesLocation) return false;
  }

  return true;
}

async function upsertJob(raw: RawJSearchJob): Promise<{ job: IJob | null; created: boolean; invalid: boolean }> {
  const normalized = JobApiAdapter.normalizeJob(raw);
  const errors = JobApiAdapter.validateNormalizedJob(normalized);
  if (errors.length > 0) {
    return { job: null, created: false, invalid: true };
  }

  const existing = await Job.findOne({
    $or: [
      { source: JobApiAdapter.SOURCE_NAME, externalJobId: normalized.externalJobId },
      ...(normalized.applicationUrl ? [{ applicationUrl: normalized.applicationUrl }] : []),
    ],
  });
  if (existing) {
    return { job: existing, created: false, invalid: false };
  }

  const created = await Job.create(normalized);
  return { job: created, created: true, invalid: false };
}

export async function ingestJobsForProfile(profileId: string): Promise<IngestResult> {
  await connectDB();

  const profile = await AutoApplyProfile.findById(profileId);
  if (!profile || !profile.enabled) {
    throw new Error(`AutoApplyProfile ${profileId} not found or disabled`);
  }

  const candidate = await Candidate.findById(profile.candidateId);
  if (!candidate) {
    throw new Error(`Candidate ${profile.candidateId} not found for profile ${profileId}`);
  }

  const syncLog = await SyncLog.create({
    source: `${JobApiAdapter.SOURCE_NAME}:auto-apply`,
    query: { profileId, candidateId: String(profile.candidateId) },
    status: "RUNNING",
  });

  const result: IngestResult = {
    profileId,
    fetched: 0,
    jobsCreated: 0,
    jobsSkippedFilter: 0,
    jobsInvalid: 0,
    applicationsCreated: 0,
    applicationsSkippedExisting: 0,
    applicationsSkippedNoRecruiter: 0,
    applicationsSkippedDailyLimit: 0,
  };

  // Reset the daily counter if it rolled over to a new day since the last run.
  const now = new Date();
  if (now.getTime() - profile.appliedTodayResetAt.getTime() > 24 * 60 * 60 * 1000) {
    profile.appliedToday = 0;
    profile.appliedTodayResetAt = now;
  }

  try {
    // Employment-type filtering happens in passesFilters() against our own
    // normalized enum — JSearch's employment_types codes (FULLTIME, CONTRACTOR, ...)
    // don't match ours, so we don't forward profile.employmentTypes to the API.
    const rawJobs = await JobApiAdapter.fetchJobs({ query: buildQuery(profile) });
    result.fetched = rawJobs.length;

    for (const raw of rawJobs) {
      const { job, created, invalid } = await upsertJob(raw);
      if (invalid) {
        result.jobsInvalid++;
        continue;
      }
      if (created) result.jobsCreated++;
      if (!job) continue;

      if (!passesFilters(job, profile)) {
        result.jobsSkippedFilter++;
        continue;
      }

      if (profile.appliedToday + result.applicationsCreated >= profile.dailyApplyLimit) {
        result.applicationsSkippedDailyLimit++;
        continue;
      }

      const existingApplication = await Application.findOne({ candidateId: candidate._id, jobId: job._id });
      if (existingApplication) {
        result.applicationsSkippedExisting++;
        continue;
      }

      if (!candidate.assignedRecruiterId) {
        result.applicationsSkippedNoRecruiter++;
        continue;
      }

      const application = await Application.create({
        candidateId: candidate._id,
        jobId: job._id,
        recruiterId: candidate.assignedRecruiterId,
        status: "PENDING_MATCHING",
        automationStatus: "QUEUED",
        resumeVersionId: profile.baseResumeId,
      });
      result.applicationsCreated++;

      await resumeTailorQueue().add("tailor-for-application", {
        applicationId: String(application._id),
        candidateId: String(candidate._id),
        jobId: String(job._id),
      });
    }

    profile.lastRunAt = now;
    await profile.save();

    syncLog.jobsFetched = result.fetched;
    syncLog.jobsCreated = result.jobsCreated;
    syncLog.jobsInvalid = result.jobsInvalid;
    syncLog.status = "SUCCESS";
    syncLog.finishedAt = new Date();
    await syncLog.save();

    return result;
  } catch (err) {
    syncLog.status = "FAILED";
    syncLog.error = err instanceof Error ? err.message : String(err);
    syncLog.finishedAt = new Date();
    await syncLog.save();
    throw err;
  }
}
