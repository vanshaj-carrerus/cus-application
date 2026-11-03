/**
 * CUS Assist, background service worker. It owns the connection to the portal (the pairing token), starts an
 * application when the portal asks, and keeps track of which tabs belong to which application. The page-side work
 * (watching, filling) is in content.ts. Nothing here drives a page from outside: it only opens ordinary tabs.
 */

import { LINKEDIN_STEPS } from "./linkedin";
import { APPLY_PORTALS, PACE_MS, type ApplyPlanData, type ApplyPortal, type JobCard } from "./linkedin-shared";
import { jobUrl, searchUrl } from "./portals/urls";

interface Config {
  server: string;
  token: string;
}

interface Claim {
  applicationId: string;
  candidateId: string;
  attemptId: string;
  entryUrl: string;
  candidate: Record<string, unknown>;
  job: { title: string; company: string; description?: string };
  coverLetter?: string;
  quickCopy: Array<{ label: string; value: string }>;
  resumeFileName: string;
  operatorName: string;
}

interface Session {
  claim: Claim;
  tabs: number[];
  filled: boolean;
  /** The resume was attached once. Sites clear the file input after accepting it, so the page can't be asked. */
  resumeAttached?: boolean;
  submitted: boolean;
}

const getConfig = async (): Promise<Config | null> => ((await chrome.storage.local.get("config")).config as Config | undefined) ?? null;

async function loadSessions(): Promise<Record<string, Session>> {
  return ((await chrome.storage.session.get("sessions")).sessions as Record<string, Session> | undefined) ?? {};
}
const saveSessions = (sessions: Record<string, Session>) => chrome.storage.session.set({ sessions });

async function sessionForTab(tabId: number | undefined): Promise<{ id: string; session: Session } | null> {
  if (tabId === undefined) return null;
  const sessions = await loadSessions();
  const id = Object.keys(sessions).find((k) => sessions[k].tabs.includes(tabId));
  return id ? { id, session: sessions[id] } : null;
}

async function api<T>(config: Config, route: string, init: { body?: unknown; raw?: boolean } = {}): Promise<T> {
  const res = await fetch(`${config.server}${route}`, {
    method: init.body !== undefined ? "POST" : "GET",
    headers: { Authorization: `Bearer ${config.token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `The portal answered ${res.status}`);
  }
  return (init.raw ? res : await res.json()) as T;
}

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
};

async function sendEvent(config: Config, applicationId: string, claim: Claim, body: Record<string, unknown>) {
  await api(config, `/api/helper/applications/${applicationId}/events`, { body: { attemptId: claim.attemptId, ...body } }).catch(() => undefined);
}

async function startApplication(applicationId: string): Promise<{ ok: boolean; error?: string }> {
  const config = await getConfig();
  if (!config) return { ok: false, error: "The extension isn't connected yet. Click Connect extension in the portal." };

  const sessions = await loadSessions();
  const existing = sessions[applicationId];
  if (existing) {
    // Already open: bring that tab forward instead of claiming it again.
    for (const tabId of existing.tabs) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) {
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
    }
    delete sessions[applicationId];
  }

  let claim: Claim;
  try {
    claim = await api<Claim>(config, `/api/helper/applications/${applicationId}/claim`, { body: {} });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not open this application" };
  }
  // Register the session before the tab exists so its content script finds it straight away.
  const tab = await chrome.tabs.create({ url: claim.entryUrl, active: true });
  sessions[applicationId] = { claim, tabs: tab.id !== undefined ? [tab.id] : [], filled: false, submitted: false };
  await saveSessions(sessions);
  return { ok: true };
}

/* ── Portal sync (LinkedIn): one tab visits each page in turn; content script reads it; results go to the portal ── */

interface LinkedInSync {
  candidateId?: string;
  tabId: number;
  idx: number;
  jobs: unknown[];
}

const getLinkedInSync = async () => ((await chrome.storage.session.get("liSync")).liSync as LinkedInSync | undefined) ?? null;
const setLinkedInSync = (s: LinkedInSync | null) => (s ? chrome.storage.session.set({ liSync: s }) : chrome.storage.session.remove("liSync"));
const syncPost = (config: Config, sync: { candidateId?: string }, body: Record<string, unknown>) =>
  api(config, "/api/helper/portals/sync", { body: { portal: "LINKEDIN", candidateId: sync.candidateId, ...body } });

async function startLinkedInSync(config: Config, candidateId: string | undefined): Promise<{ ok: boolean; error?: string }> {
  const running = await getLinkedInSync();
  if (running && (await chrome.tabs.get(running.tabId).catch(() => null))) {
    await chrome.tabs.update(running.tabId, { active: true });
    return { ok: true };
  }
  try {
    await syncPost(config, { candidateId }, { type: "start" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not start the sync" };
  }
  const tab = await chrome.tabs.create({ url: LINKEDIN_STEPS[0].url, active: true });
  if (tab.id === undefined) return { ok: false, error: "Could not open LinkedIn" };
  await setLinkedInSync({ candidateId, tabId: tab.id, idx: 0, jobs: [] });
  return { ok: true };
}

async function endLinkedInSync(config: Config, sync: LinkedInSync, error?: string) {
  await setLinkedInSync(null);
  await syncPost(config, sync, error ? { type: "error", message: error } : { type: "done" }).catch(() => undefined);
  await chrome.tabs.remove(sync.tabId).catch(() => undefined);
}

async function handleLinkedIn(message: Record<string, unknown>, sender: chrome.runtime.MessageSender, config: Config): Promise<unknown> {
  const sync = await getLinkedInSync();
  if (!sync || sender.tab?.id !== sync.tabId) return null;

  if (message.type === "liTask") return { key: LINKEDIN_STEPS[sync.idx]?.key, idx: sync.idx };

  // liResult: ignore a duplicate from a page that loaded twice (redirects)
  if (message.idx !== sync.idx) return { ok: true };
  if (typeof message.error === "string") {
    await endLinkedInSync(config, sync, message.error);
    return { ok: true };
  }
  const step = LINKEDIN_STEPS[sync.idx];
  try {
    if (step.key === "profile" || step.key === "messages") {
      await syncPost(config, sync, { type: "section", section: step.key, data: message.data });
    } else {
      sync.jobs.push(...(Array.isArray(message.data) ? message.data : []));
      if (step.key === "jobs-applied") await syncPost(config, sync, { type: "section", section: "jobs", data: sync.jobs });
    }
  } catch (err) {
    // The server already recorded why (e.g. a different LinkedIn account is signed in).
    await setLinkedInSync(null);
    await chrome.tabs.remove(sync.tabId).catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  sync.idx += 1;
  if (sync.idx >= LINKEDIN_STEPS.length) {
    await endLinkedInSync(config, sync);
    return { ok: true };
  }
  await setLinkedInSync(sync);
  await syncPost(config, sync, { type: "progress", message: `Reading LinkedIn: ${LINKEDIN_STEPS[sync.idx].key.replace("-", " ")}…` }).catch(() => undefined);
  await chrome.tabs.update(sync.tabId, { url: LINKEDIN_STEPS[sync.idx].url });
  return { ok: true };
}

/* ── Auto-apply (LinkedIn): any number of runs at once. Each run has its own window and works one job at a time (Easy Apply
   there, or the company's own site) until it has sent its target or the list ends. Runs share nothing but the candidate:
   the server hands each job to one run only. ── */

interface LinkedInApply {
  id: string;
  /** Which portal this run works on (LinkedIn, Glassdoor...). */
  portal: ApplyPortal;
  candidateId?: string;
  tabId: number;
  plan: ApplyPlanData;
  searchIdx: number;
  /** "external": the job's Apply button led to the company's own site; its tabs do the work until they report. */
  stage: "search" | "job" | "external";
  queue: JobCard[];
  qi: number;
  applied: number;
  seen: string[];
  seq: number;
  /** Wait before the content script starts the job that was just opened. */
  delayMs: number;
  /** Tabs opened by the job's Apply button (the company's site and anything it opens). */
  extTabs: number[];
}

const WATCHDOG = "liApplyWatchdog";
const STALL_MS = 5 * 60_000;
const RUN_KEY = "liApply:";
const aliveKey = (id: string) => `liApplyAlive:${id}`;
const pausedKey = (id: string) => `liApplyPaused:${id}`;

/** Every run lives under its own storage key, so runs never overwrite each other's state. */
async function getRuns(): Promise<LinkedInApply[]> {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(RUN_KEY))
    .map(([, value]) => value as LinkedInApply);
}
const saveRun = (run: LinkedInApply) => chrome.storage.session.set({ [`${RUN_KEY}${run.id}`]: run });
const dropRun = (run: LinkedInApply) => chrome.storage.session.remove([`${RUN_KEY}${run.id}`, aliveKey(run.id), pausedKey(run.id)]);
const touchApply = (run: LinkedInApply) => chrome.storage.session.set({ [aliveKey(run.id)]: Date.now() });
const applyPost = <T = unknown>(config: Config, run: { candidateId?: string; portal: ApplyPortal }, body: Record<string, unknown>) =>
  api<T>(config, "/api/helper/portals/apply", { body: { portal: run.portal, candidateId: run.candidateId, ...body } });

/** The run a tab belongs to: its own tab, a tab its Apply button opened, or one of those tabs' popups. */
async function runForTab(tabId: number, openerTabId: number | undefined): Promise<LinkedInApply | null> {
  const runs = await getRuns();
  return (
    runs.find((r) => r.tabId === tabId || r.extTabs.includes(tabId)) ??
    runs.find((r) => r.stage === "external" && openerTabId !== undefined && (r.tabId === openerTabId || r.extTabs.includes(openerTabId))) ??
    null
  );
}

async function startLinkedInApply(config: Config, candidateId: string | undefined, portal: ApplyPortal): Promise<{ ok: boolean; error?: string }> {
  let plan: ApplyPlanData;
  try {
    plan = await applyPost<ApplyPlanData>(config, { candidateId, portal }, { action: "plan" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not start" };
  }
  // Unfinished applications first (their questions may have been answered since); the search starts when they are done.
  const retry = plan.retryJobs ?? [];
  const first = (await getRuns()).length === 0;
  // A window of its own per run: a tab hidden behind others is slowed down by the browser, a window is not.
  const win = await chrome.windows.create({ url: retry.length ? jobUrl(portal, retry[0]) : searchUrl(portal, plan.searches[0]), focused: first });
  const tabId = win?.tabs?.[0]?.id;
  if (tabId === undefined) return { ok: false, error: "Could not open LinkedIn" };

  const run: LinkedInApply = {
    id: crypto.randomUUID(),
    portal,
    candidateId,
    tabId,
    plan,
    searchIdx: retry.length ? -1 : 0,
    stage: retry.length ? "job" : "search",
    queue: retry,
    qi: 0,
    applied: 0,
    seen: retry.map((j) => j.id),
    seq: 1,
    delayMs: PACE_MS.first,
    extTabs: [],
  };
  await saveRun(run);
  await touchApply(run);
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  return { ok: true };
}

async function closeExtTabs(run: LinkedInApply) {
  for (const id of run.extTabs) if (id !== run.tabId) await chrome.tabs.remove(id).catch(() => undefined);
  run.extTabs = [];
}

async function endLinkedInApply(config: Config, run: LinkedInApply, state: "DONE" | "STOPPED" | "FAILED", message: string) {
  await dropRun(run);
  if ((await getRuns()).length === 0) await chrome.alarms.clear(WATCHDOG);
  await applyPost(config, run, { action: "finish", state, message }).catch(() => undefined);
  await closeExtTabs(run);
  // A failed run leaves its window open: the status box on it says what went wrong.
  if (state !== "FAILED") await chrome.tabs.remove(run.tabId).catch(() => undefined);
}

/** Moves on to the next job, the next search, or the end. */
async function advanceLinkedInApply(config: Config, run: LinkedInApply) {
  run.seq += 1;
  await closeExtTabs(run);
  await touchApply(run);
  await chrome.storage.session.set({ [pausedKey(run.id)]: false });

  // Jobs another run already has are left to it.
  while (run.qi < run.queue.length) {
    const free = await applyPost<{ ok: boolean }>(config, run, { action: "claim", job: run.queue[run.qi] }).then((r) => r.ok).catch(() => true);
    if (free) break;
    run.qi += 1;
  }

  if (run.qi < run.queue.length) {
    run.stage = "job";
    run.delayMs = run.qi === 0 ? PACE_MS.first : PACE_MS.gap;
    await saveRun(run);
    await applyPost(config, run, { action: "progress", state: "RUNNING", message: `Applying (${run.applied} sent so far): ${run.queue[run.qi].title}` }).catch(() => undefined);
    await chrome.tabs.update(run.tabId, { url: jobUrl(run.portal, run.queue[run.qi]) });
    return;
  }
  run.searchIdx += 1;
  if (run.searchIdx >= run.plan.searches.length) {
    await endLinkedInApply(config, run, "DONE", run.applied ? `Finished. ${run.applied} application(s) sent.` : "Finished. No new matching jobs were found.");
    return;
  }
  run.stage = "search";
  run.queue = [];
  run.qi = 0;
  await saveRun(run);
  await chrome.tabs.update(run.tabId, { url: searchUrl(run.portal, run.plan.searches[run.searchIdx]) });
}

/** Records how the current job ended, then goes on to the next one (or stops, if asked to, at the run's target, or at today's cap). */
async function completeJob(config: Config, run: LinkedInApply, outcome: string, reason?: string, company?: string) {
  const job = { ...run.queue[run.qi], company: company || run.queue[run.qi].company };
  let verdict = { stop: false, remaining: 1 };
  try {
    verdict = await applyPost<{ stop: boolean; remaining: number }>(config, run, { action: "result", job, outcome, reason });
  } catch (err) {
    await endLinkedInApply(config, run, "FAILED", err instanceof Error ? err.message : "Could not record the result");
    return;
  }
  if (outcome === "APPLIED") run.applied += 1;
  if (verdict.stop) return endLinkedInApply(config, run, "STOPPED", `Stopped. ${run.applied} application(s) sent.`);
  if (verdict.remaining <= 0) return endLinkedInApply(config, run, "DONE", `Today's limit reached. ${run.applied} application(s) sent.`);
  if (run.applied >= (run.plan.runTarget ?? 10)) return endLinkedInApply(config, run, "DONE", `Finished: ${run.applied} application(s) sent.`);
  run.qi += 1;
  await advanceLinkedInApply(config, run);
}

async function handleLinkedInApply(message: Record<string, unknown>, sender: chrome.runtime.MessageSender, config: Config): Promise<unknown> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  const run = await runForTab(tabId, sender.tab?.openerTabId);
  if (!run) return null;
  if (tabId !== run.tabId && !run.extTabs.includes(tabId)) {
    run.extTabs.push(tabId);
    await saveRun(run);
  }
  await touchApply(run);

  switch (message.type) {
    case "liApplyTask":
      if (run.stage === "external") return { kind: "external", seq: run.seq, job: run.queue[run.qi], candidate: run.plan.candidate };
      if (tabId !== run.tabId) return null;
      if (run.stage === "search") return { kind: "search", seq: run.seq };
      return { kind: "job", seq: run.seq, job: run.queue[run.qi], candidate: run.plan.candidate, delayMs: run.delayMs };

    case "liApplyProgress":
      await chrome.storage.session.set({ [pausedKey(run.id)]: message.state === "PAUSED" });
      await applyPost(config, run, { action: "progress", state: message.state, message: message.message }).catch(() => undefined);
      return { ok: true };

    case "liApplyResume":
      return applyPost(config, run, { action: "resume" }).catch(() => ({ resume: null }));

    case "liApplyAnswers":
      return applyPost(config, run, { action: "answers", job: message.job, request: message.request }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));

    case "liApplyExternal": {
      // The job has no Easy Apply: its Apply button is about to open the company's site. Announced before the click so the new tab is recognised.
      run.stage = "external";
      run.seq += 1;
      if (typeof message.company === "string" && message.company && !run.queue[run.qi].company) run.queue[run.qi].company = message.company;
      if (typeof message.url === "string" && /^https?:/i.test(message.url)) {
        const tab = await chrome.tabs.create({ url: message.url, active: true, openerTabId: run.tabId, windowId: (await chrome.tabs.get(run.tabId).catch(() => null))?.windowId });
        if (tab.id !== undefined) run.extTabs.push(tab.id);
      }
      await saveRun(run);
      return { ok: true, seq: run.seq };
    }

    case "liApplyExtCount":
      return { count: run.extTabs.length };

    case "liApplyOpen": {
      // An address the portal's page tried to open in a new window (a pop-up the browser would have blocked): opened here instead.
      if (typeof message.url === "string" && /^https?:/i.test(message.url)) {
        const tab = await chrome.tabs.create({ url: message.url, active: true, openerTabId: run.tabId, windowId: (await chrome.tabs.get(run.tabId).catch(() => null))?.windowId });
        if (tab.id !== undefined) {
          run.extTabs.push(tab.id);
          await saveRun(run);
        }
      }
      return { ok: true };
    }

    case "liApplyResult": {
      if (message.seq !== run.seq) return { ok: true }; // a duplicate, or from a page that is no longer current
      if (typeof message.error === "string") {
        await endLinkedInApply(config, run, "FAILED", message.error);
        return { ok: true };
      }

      if (message.kind === "search") {
        const exclude = run.plan.excludeKeywords.map((k) => k.toLowerCase()).filter(Boolean);
        const done = new Set([...run.plan.appliedIds, ...run.seen]);
        const jobs = (Array.isArray(message.jobs) ? (message.jobs as JobCard[]) : []).filter((j) => !done.has(j.id) && !exclude.some((k) => j.title.toLowerCase().includes(k)));
        // The long applications (on the company's own site) come first; Easy Apply ones after.
        jobs.sort((a, b) => Number(!!a.easy) - Number(!!b.easy));
        run.seen.push(...jobs.map((j) => j.id));
        run.queue = jobs;
        run.qi = 0;
        await advanceLinkedInApply(config, run);
        return { ok: true };
      }

      await completeJob(config, run, String(message.outcome), typeof message.reason === "string" ? message.reason : undefined, typeof message.company === "string" ? message.company : undefined);
      return { ok: true };
    }
  }
  return null;
}

/** No sign of life from a run for five minutes (and nobody being waited for): give up on its job and move on, so one page can never freeze a run. */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  const runs = await getRuns();
  const config = await getConfig();
  if (runs.length === 0 || !config) return void chrome.alarms.clear(WATCHDOG);
  for (const run of runs) {
    const state = await chrome.storage.session.get([aliveKey(run.id), pausedKey(run.id)]);
    if (state[pausedKey(run.id)] || Date.now() - ((state[aliveKey(run.id)] as number | undefined) ?? 0) < STALL_MS) continue;
    if (run.stage === "search") await endLinkedInApply(config, run, "FAILED", "The search page did not load. Check that the portal is signed in.");
    else await completeJob(config, run, "FAILED", "Stalled: no progress for 5 minutes");
  }
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function handle(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const config = await getConfig();
  const senderOrigin = originOf(sender.tab?.url ?? sender.url);

  switch (message.type) {
    case "ping":
      return { paired: !!config && config.server === senderOrigin };

    case "pair": {
      // The server is always the page's own origin (never something the page claims), and the page already asked the
      // person to confirm. A forged page can therefore only ever pair the extension with itself.
      const host = senderOrigin ? new URL(senderOrigin) : null;
      const secure = host && (host.protocol === "https:" || host.hostname === "localhost" || host.hostname === "127.0.0.1");
      if (typeof message.token !== "string" || !secure) return { ok: false };
      await chrome.storage.local.set({ config: { server: senderOrigin, token: message.token } satisfies Config });
      return { ok: true };
    }

    case "apply": {
      if (!config || config.server !== senderOrigin) return { ok: false, error: "This page isn't the portal this extension is connected to." };
      if (typeof message.applicationId !== "string") return { ok: false, error: "Bad request" };
      return startApplication(message.applicationId);
    }

    case "portalSync": {
      if (!config || config.server !== senderOrigin) return { ok: false, error: "This page isn't the portal this extension is connected to." };
      if (message.portal !== "LINKEDIN") return { ok: false, error: "This portal can't be synced yet." };
      return startLinkedInSync(config, typeof message.candidateId === "string" ? message.candidateId : undefined);
    }

    case "portalApply": {
      if (!config || config.server !== senderOrigin) return { ok: false, error: "This page isn't the portal this extension is connected to." };
      const portal = APPLY_PORTALS.find((p) => p === message.portal);
      if (!portal) return { ok: false, error: "Auto-apply isn't available for this portal yet." };
      return startLinkedInApply(config, typeof message.candidateId === "string" ? message.candidateId : undefined, portal);
    }

    case "liTask":
    case "liResult":
      return config ? handleLinkedIn(message, sender, config) : null;

    case "liApplyTask":
    case "liApplyResult":
    case "liApplyProgress":
    case "liApplyAnswers":
    case "liApplyResume":
    case "liApplyExternal":
    case "liApplyExtCount":
    case "liApplyOpen":
      return config ? handleLinkedInApply(message, sender, config) : null;

    case "disconnect":
      await chrome.storage.local.remove("config");
      return { ok: true };
  }

  // Everything below belongs to a tab that is part of an application.
  const found = await sessionForTab(sender.tab?.id);
  if (!found || !config) return null;
  const { id, session } = found;
  const tabId = sender.tab!.id!;

  switch (message.type) {
    case "session":
      return { applicationId: id, candidate: session.claim.candidate, job: session.claim.job, coverLetter: session.claim.coverLetter, quickCopy: session.claim.quickCopy, filled: session.filled, resumeAttached: !!session.resumeAttached, submitted: session.submitted };

    case "resume": {
      const res = await api<Response>(config, `/api/helper/applications/${id}/resume`, { raw: true });
      return { name: session.claim.resumeFileName, base64: bytesToBase64(new Uint8Array(await res.arrayBuffer())) };
    }

    case "answers":
      return api(config, `/api/helper/applications/${id}/answers`, { body: message.body });

    case "step":
      await sendEvent(config, id, session.claim, { type: "step", step: message.step, status: message.status, message: message.message });
      return { ok: true };

    case "filled": {
      const sessions = await loadSessions();
      if (sessions[id]) sessions[id].filled = true;
      await saveSessions(sessions);
      return { ok: true };
    }

    case "resumeAttached": {
      const sessions = await loadSessions();
      if (sessions[id]) sessions[id].resumeAttached = true;
      await saveSessions(sessions);
      return { ok: true };
    }

    case "submitted": {
      if (session.submitted) return { ok: true };
      const sessions = await loadSessions();
      if (sessions[id]) sessions[id].submitted = true;
      await saveSessions(sessions);
      // A screenshot of the confirmation is the audit proof; capturing needs this tab to be the visible one.
      let screenshotBase64: string | undefined;
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab!.windowId, { format: "png" });
        screenshotBase64 = dataUrl.split(",")[1];
      } catch {
        /* proof is nice to have; the submission still counts */
      }
      await sendEvent(config, id, session.claim, { type: "submitted", evidence: message.evidence, finalUrl: sender.tab?.url, screenshotBase64 });
      return { ok: true };
    }

    case "status":
      // Frames report to the top frame, which owns the on-page bar.
      await chrome.tabs.sendMessage(tabId, { type: "showStatus", text: message.text }, { frameId: 0 }).catch(() => undefined);
      return { ok: true };

    case "forceFill":
      await chrome.tabs.sendMessage(tabId, { type: "doFill" }).catch(() => undefined);
      return { ok: true };
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // answered asynchronously
});

// Closing the LinkedIn tab before the sync is done ends the sync, and says so in the portal.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sync = await getLinkedInSync();
  const config = await getConfig();
  if (!sync || sync.tabId !== tabId || !config) return;
  await setLinkedInSync(null);
  await syncPost(config, sync, { type: "error", message: "The LinkedIn tab was closed before the sync finished." }).catch(() => undefined);
});

// Closing a run's window ends that run, and says so in the portal.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const config = await getConfig();
  const run = (await getRuns()).find((r) => r.tabId === tabId);
  if (!run || !config) return;
  await dropRun(run);
  if ((await getRuns()).length === 0) await chrome.alarms.clear(WATCHDOG);
  await closeExtTabs(run);
  await applyPost(config, run, { action: "finish", state: "STOPPED", message: `A run's window was closed. ${run.applied} application(s) sent.` }).catch(() => undefined);
});

// A link on the job page that opens a new tab keeps that tab in the same application.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined || tab.id === undefined) return;
  const found = await sessionForTab(tab.openerTabId);
  if (!found) return;
  const sessions = await loadSessions();
  if (sessions[found.id] && !sessions[found.id].tabs.includes(tab.id)) {
    sessions[found.id].tabs.push(tab.id);
    await saveSessions(sessions);
  }
});

// When the last tab of an application closes without a confirmation, put it back in the queue.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const found = await sessionForTab(tabId);
  if (!found) return;
  const sessions = await loadSessions();
  const session = sessions[found.id];
  if (!session) return;
  session.tabs = session.tabs.filter((t) => t !== tabId);
  if (session.tabs.length > 0) {
    await saveSessions(sessions);
    return;
  }
  delete sessions[found.id];
  await saveSessions(sessions);
  const config = await getConfig();
  if (config && !session.submitted) await sendEvent(config, found.id, session.claim, { type: "closed" });
});
