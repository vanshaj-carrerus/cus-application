import { ApplicationAttempt } from "@/lib/models/ApplicationAttempt";
import { Job } from "@/lib/models/Job";
import { classifyHost, type HostClass } from "@/lib/automation/hostPolicy";

/**
 * "How is the bot actually doing, per site?" — built from the attempt trail the worker already writes, so it
 * needs no extra instrumentation. Each attempt lands in exactly one outcome:
 *
 *   applied      confirmed submitted
 *   handedOff    stopped on purpose for a person (login/CAPTCHA/OTP wall, unanswerable question, host policy…)
 *   failed       errored or gave up
 *   dryRun       test runs (APPLY_DRY_RUN) — shown, but never counted as a failure or a success
 *   inProgress   still running
 */

export type Outcome = "applied" | "handedOff" | "failed" | "dryRun" | "inProgress";

interface AttemptLike {
  status: string;
  steps?: Array<{ step: string; status: string; message?: string }>;
  submissionConfirmation?: Record<string, unknown>;
  jobId: { toString(): string };
  startedAt?: Date;
}

export function outcomeOf(attempt: AttemptLike): Outcome {
  const steps = attempt.steps ?? [];
  if (steps.some((s) => s.step === "dry_run")) return "dryRun";
  switch (attempt.status) {
    case "SUCCESS":
      return "applied";
    case "FAILED":
      return "failed";
    case "RUNNING":
    case "PENDING":
      return "inProgress";
    default:
      return "handedOff"; // NEEDS_REVIEW, BLOCKED_*
  }
}

/** The one-line reason an attempt stopped, with the parts that vary per run (URLs, ids, numbers) removed so equal causes group together. */
export function stopReasonOf(attempt: AttemptLike): string | null {
  const steps = attempt.steps ?? [];
  const failed = [...steps].reverse().find((s) => s.status === "FAILED" || s.status === "SKIPPED");
  const raw = failed?.message;
  if (!raw) return null;
  return raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\(got as far as:[^)]*\)?/gi, "")
    .replace(/\(task \d+\)/gi, "")
    .replace(/\b[0-9a-f]{24}\b/gi, "")
    .replace(/"[^"]{1,80}"/g, '"…"')
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .replace(/[\s:;—-]+$/, "")
    .trim()
    .slice(0, 160);
}

/** One row per site, not per subdomain: in.linkedin.com and www.linkedin.com are the same site; so are all Workday tenants. */
export function siteKey(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const twoPartSuffix = last.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(second);
  return labels.slice(twoPartSuffix ? -3 : -2).join(".");
}

export interface HostStats {
  host: string;
  hostClass: HostClass;
  attempts: number;
  applied: number;
  handedOff: number;
  failed: number;
  dryRun: number;
  inProgress: number;
  /** applied / (applied + handedOff + failed): what share of real attempts got through. Null until there is one. */
  successRate: number | null;
  /** Of the applied ones, how many have the employer's confirmation email. */
  emailConfirmed: number;
  topReasons: Array<{ reason: string; count: number }>;
  lastAttemptAt: string | null;
  advice: string | null;
}

export interface AutomationStats {
  days: number;
  totals: { attempts: number; applied: number; handedOff: number; failed: number; dryRun: number; inProgress: number; successRate: number | null; emailConfirmed: number };
  hosts: HostStats[];
  topReasons: Array<{ reason: string; count: number }>;
}

const rate = (applied: number, real: number) => (real > 0 ? Math.round((applied / real) * 1000) / 10 : null);

function adviceFor(h: Omit<HostStats, "advice">): string | null {
  const real = h.applied + h.handedOff + h.failed;
  if (real < 3) return null;
  if (h.hostClass === "SESSION" && h.applied === 0) return "Bot checks block this site. Apply here by hand, or save a signed-in session with board-login.";
  if (h.applied === 0) return `0 of ${real} real attempts got through — worth a look at the top stop reason below, or hand this site to recruiters.`;
  if (h.successRate !== null && h.successRate < 50) return "Under half get through — fix the top stop reason below.";
  return null;
}

export async function computeAutomationStats(days = 30): Promise<AutomationStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const attempts = await ApplicationAttempt.find({ startedAt: { $gte: since } })
    .select("status steps jobId startedAt submissionConfirmation")
    .sort({ startedAt: -1 })
    .limit(20_000)
    .lean();

  const jobIds = [...new Set(attempts.map((a) => String(a.jobId)))];
  const jobs = await Job.find({ _id: { $in: jobIds } })
    .select("applicationUrl")
    .lean();
  const urlByJob = new Map(jobs.map((j) => [String(j._id), j.applicationUrl ?? ""]));

  type Acc = Omit<HostStats, "successRate" | "topReasons" | "advice"> & { reasons: Map<string, number> };
  const byHost = new Map<string, Acc>();
  const overall = new Map<string, number>();
  const totals = { attempts: 0, applied: 0, handedOff: 0, failed: 0, dryRun: 0, inProgress: 0, emailConfirmed: 0 };

  for (const attempt of attempts) {
    const url = urlByJob.get(String(attempt.jobId)) ?? "";
    const info = classifyHost(url);
    const host = info.host ? siteKey(info.host) : "(unknown)";
    const acc =
      byHost.get(host) ??
      ({ host, hostClass: info.hostClass, attempts: 0, applied: 0, handedOff: 0, failed: 0, dryRun: 0, inProgress: 0, emailConfirmed: 0, lastAttemptAt: null, reasons: new Map() } as Acc);
    byHost.set(host, acc);

    const outcome = outcomeOf(attempt as AttemptLike);
    acc.attempts++;
    acc[outcome]++;
    totals.attempts++;
    totals[outcome]++;
    if (outcome === "applied" && (attempt.submissionConfirmation as { emailConfirmed?: boolean } | undefined)?.emailConfirmed) {
      acc.emailConfirmed++;
      totals.emailConfirmed++;
    }
    if (!acc.lastAttemptAt && attempt.startedAt) acc.lastAttemptAt = new Date(attempt.startedAt).toISOString();

    if (outcome === "handedOff" || outcome === "failed") {
      const reason = stopReasonOf(attempt as AttemptLike);
      if (reason) {
        acc.reasons.set(reason, (acc.reasons.get(reason) ?? 0) + 1);
        overall.set(reason, (overall.get(reason) ?? 0) + 1);
      }
    }
  }

  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([reason, count]) => ({ reason, count }));

  const hosts: HostStats[] = [...byHost.values()]
    .map(({ reasons, ...rest }) => {
      const real = rest.applied + rest.handedOff + rest.failed;
      const base = { ...rest, successRate: rate(rest.applied, real), topReasons: top(reasons, 3) };
      return { ...base, advice: adviceFor(base) };
    })
    .sort((a, b) => b.attempts - a.attempts);

  const realTotal = totals.applied + totals.handedOff + totals.failed;
  return { days, totals: { ...totals, successRate: rate(totals.applied, realTotal) }, hosts, topReasons: top(overall, 8) };
}
