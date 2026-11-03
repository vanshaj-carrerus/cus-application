import { PortalConnection } from "@/lib/models/PortalConnection";
import { PortalSnapshot } from "@/lib/models/PortalSnapshot";
import { Candidate } from "@/lib/models/Candidate";
import { getPortal } from "@/lib/portals/catalog";
import { LINKEDIN_SECTIONS, cleanJobs, cleanProfile, cleanThreads, linkedInSlug } from "@/lib/portals/linkedin";

export class PortalSyncError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function getSnapshot(candidateId: string, portal: string) {
  const snap = await PortalSnapshot.findOne({ candidateId, portal });
  if (!snap) return { sections: {}, run: null, apply: null };
  // A run that never reported back (tab crashed, extension removed) must not look like it is still going.
  const stale = snap.run?.state === "RUNNING" && snap.run.startedAt && Date.now() - snap.run.startedAt.getTime() > 10 * 60_000;
  const run = snap.run?.state ? { state: stale ? ("FAILED" as const) : snap.run.state, message: stale ? "The sync did not finish. Try again." : snap.run.message, startedAt: snap.run.startedAt } : null;
  // Same for an auto-apply run: nothing legitimate runs for hours, so an old "running" record is a dead run.
  const apply = snap.apply as { state: string; message?: string; startedAt: Date } | undefined;
  const applyStale = !!apply && ["RUNNING", "PAUSED", "STOPPING"].includes(apply.state) && Date.now() - new Date(apply.startedAt).getTime() > 3 * 60 * 60_000;
  return { sections: snap.sections ?? {}, run, apply: apply ? (applyStale ? { ...apply, state: "STOPPED", message: "This run is no longer active." } : apply) : null };
}

/** The connection must exist first: it carries the profile URL that says whose account the browser must be signed in to. */
export async function requireConnection(candidateId: string, portal: string) {
  const def = getPortal(portal);
  if (!def?.extensionSync) throw new PortalSyncError("This portal can't be synced from the browser extension");
  const conn = await PortalConnection.findOne({ candidateId, portal });
  if (!conn) throw new PortalSyncError("Connect this portal first, with the profile URL", 409);
  return conn;
}

export async function startRun(candidateId: string, portal: string) {
  await requireConnection(candidateId, portal);
  await PortalSnapshot.updateOne(
    { candidateId, portal },
    { $set: { run: { state: "RUNNING", message: "Waiting for the browser…", startedAt: new Date() } } },
    { upsert: true }
  );
}

export async function failRun(candidateId: string, portal: string, message: string) {
  const conn = await requireConnection(candidateId, portal);
  await PortalSnapshot.updateOne(
    { candidateId, portal },
    { $set: { "run.state": "FAILED", "run.message": message.slice(0, 500), "run.finishedAt": new Date() } },
    { upsert: true }
  );
  conn.statusNote = message.slice(0, 500);
  await conn.save();
}

export async function finishRun(candidateId: string, portal: string) {
  await PortalSnapshot.updateOne(
    { candidateId, portal },
    { $set: { "run.state": "DONE", "run.message": "Sync complete", "run.finishedAt": new Date() } },
    { upsert: true }
  );
}

export async function progress(candidateId: string, portal: string, message: string) {
  await PortalSnapshot.updateOne({ candidateId, portal }, { $set: { "run.state": "RUNNING", "run.message": message.slice(0, 200) } }, { upsert: true });
}

/** Stores one section read from the browser. The profile section also proves the account, so it sets the connection status. */
export async function saveSection(candidateId: string, portal: string, section: string, raw: unknown) {
  if (!(LINKEDIN_SECTIONS as readonly string[]).includes(section)) throw new PortalSyncError("Unknown section");
  const conn = await requireConnection(candidateId, portal);

  let data: unknown;
  if (section === "profile") {
    const profile = cleanProfile(raw);
    if (!profile) throw new PortalSyncError("The browser did not send a readable profile");
    const expected = linkedInSlug(conn.profileUrl);
    const actual = linkedInSlug(profile.url);
    if (expected && actual && expected !== actual) {
      throw new PortalSyncError(`This browser is signed in to linkedin.com/in/${actual}, but the connected account is linkedin.com/in/${expected}. Sign in to the right account and sync again.`, 409);
    }
    data = profile;
    conn.status = "ACTIVE";
    conn.lastVerifiedAt = new Date();
    conn.statusNote = undefined;
    await conn.save();
    // Keep the candidate's own record in step where it is empty; never overwrite what staff or the candidate typed.
    await Candidate.updateOne({ _id: candidateId, $or: [{ linkedinUrl: { $exists: false } }, { linkedinUrl: "" }] }, { $set: { linkedinUrl: profile.url } }).catch(() => undefined);
  } else if (section === "messages") {
    data = cleanThreads(raw);
  } else {
    data = cleanJobs(raw);
  }

  await PortalSnapshot.updateOne({ candidateId, portal }, { $set: { [`sections.${section}`]: { data, syncedAt: new Date() } } }, { upsert: true });
}
