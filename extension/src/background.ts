/**
 * CUS Assist, background service worker. It owns the connection to the portal (the pairing token), starts an
 * application when the portal asks, and keeps track of which tabs belong to which application. The page-side work
 * (watching, filling) is in content.ts. Nothing here drives a page from outside: it only opens ordinary tabs.
 */

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
