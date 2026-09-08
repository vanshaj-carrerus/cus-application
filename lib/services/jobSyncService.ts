import { connectDB } from "@/lib/db/mongodb";
import { Job } from "@/lib/models/Job";
import { SyncLog } from "@/lib/models/SyncLog";
import { JobApiAdapter } from "@/lib/adapters/jobApiAdapter";

export async function syncJobs(query: string, opts: { page?: number; numPages?: number } = {}) {
  await connectDB();

  const syncLog = await SyncLog.create({ source: JobApiAdapter.SOURCE_NAME, query: { query, ...opts }, status: "RUNNING" });

  let created = 0;
  let updated = 0;
  let duplicate = 0;
  let invalid = 0;

  try {
    const rawJobs = await JobApiAdapter.fetchJobs({ query, ...opts });
    syncLog.jobsFetched = rawJobs.length;

    for (const raw of rawJobs) {
      const normalized = JobApiAdapter.normalizeJob(raw);
      const errors = JobApiAdapter.validateNormalizedJob(normalized);
      if (errors.length > 0) {
        invalid++;
        continue;
      }

      const existing = await Job.findOne({ source: JobApiAdapter.SOURCE_NAME, externalJobId: normalized.externalJobId });
      if (existing) {
        // Duplicate detection: same external id already stored. Update mutable fields only.
        existing.status = normalized.status ?? existing.status;
        existing.applicationUrl = normalized.applicationUrl ?? existing.applicationUrl;
        existing.expiresAt = normalized.expiresAt ?? existing.expiresAt;
        await existing.save();
        duplicate++;
        updated++;
        continue;
      }

      await Job.create(normalized);
      created++;
    }

    syncLog.jobsCreated = created;
    syncLog.jobsUpdated = updated;
    syncLog.jobsDuplicate = duplicate;
    syncLog.jobsInvalid = invalid;
    syncLog.status = "SUCCESS";
    syncLog.finishedAt = new Date();
    await syncLog.save();

    return { fetched: rawJobs.length, created, updated, duplicate, invalid, syncLogId: syncLog._id };
  } catch (err) {
    syncLog.status = "FAILED";
    syncLog.error = err instanceof Error ? err.message : String(err);
    syncLog.finishedAt = new Date();
    await syncLog.save();
    throw err;
  }
}
