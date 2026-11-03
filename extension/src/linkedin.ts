import type { LinkedInEntry, LinkedInJob, LinkedInMessage, LinkedInThread } from "../../lib/portals/linkedin";

/**
 * Reads the signed-in candidate's own LinkedIn pages, one step per page load, when (and only when) the portal asked
 * for a sync and the background worker says this tab is the sync tab. It only reads: no connecting, messaging,
 * applying or clicking anything except opening the existing conversations to read them. Reading is paced and
 * capped. LinkedIn's markup changes without notice, so every reader returns what it can find and the portal shows
 * exactly that.
 */

export const LINKEDIN_STEPS = [
  { key: "profile", url: "https://www.linkedin.com/in/me/" },
  { key: "messages", url: "https://www.linkedin.com/messaging/" },
  { key: "jobs-saved", url: "https://www.linkedin.com/my-items/saved-jobs/" },
  { key: "jobs-applied", url: "https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED" },
] as const;
export type LinkedInStepKey = (typeof LINKEDIN_STEPS)[number]["key"];

const MAX_THREADS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

async function waitFor<T>(find: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = find();
    if (found) return found;
    await sleep(300);
  }
  return null;
}

/** Scrolls down in steps so lazily rendered sections (experience, skills) are in the page before reading. */
async function scrollThrough() {
  for (let i = 0; i < 6; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(500);
  }
  window.scrollTo(0, 0);
}

function signedOut(): boolean {
  return /^\/(login|checkpoint|authwall|uas)(\/|$)/.test(location.pathname);
}

/** The visible text lines of a list item, de-duplicated (LinkedIn repeats text for screen readers). */
function lines(root: Element): string[] {
  const spans = [...root.querySelectorAll('span[aria-hidden="true"]')].map((s) => clean(s.textContent)).filter(Boolean);
  const source = spans.length ? spans : (root as HTMLElement).innerText.split("\n").map(clean).filter(Boolean);
  return source.filter((l, i) => l !== source[i - 1]);
}

/** What the page actually contains, appended to errors so a failed read can be diagnosed without opening DevTools. */
function diagnose(): string {
  const heads = [...document.querySelectorAll("h1, h2, h3")].slice(0, 8).map((h) => clean(h.textContent).slice(0, 40)).filter(Boolean);
  return `[${location.pathname} | title "${document.title.slice(0, 60)}" | headings: ${heads.join(" / ") || "none"}]`;
}

/** The page title is "(3) Jane Doe - Engineer at X | LinkedIn": the most stable place for the name. */
const nameFromTitle = () => clean(document.title.replace(/^\(\d+\)\s*/, "").split(" | ")[0].split(" - ")[0]);

const sectionById = (id: string) => document.getElementById(id)?.closest("section") ?? null;

/** Finds a profile section by its visible heading ("Experience"), which survives markup changes better than class names. */
function sectionByHeading(title: string): Element | null {
  const want = title.toLowerCase();
  for (const h of document.querySelectorAll("h2, h3, [role=heading]")) {
    const text = clean(h.textContent).toLowerCase();
    if (text !== want && text !== want + want && lines(h)[0]?.toLowerCase() !== want) continue;
    const section = h.closest("section");
    if (section) return section;
    // No <section>: climb until the container holds the list items.
    let node: Element | null = h.parentElement;
    for (let i = 0; i < 5 && node && !node.querySelector("li"); i++) node = node.parentElement;
    return node;
  }
  return null;
}
const findSection = (id: string, title: string) => sectionById(id) ?? sectionByHeading(title);

function entriesIn(section: Element | null): LinkedInEntry[] {
  if (!section) return [];
  return [...section.querySelectorAll("li")]
    .filter((li) => !li.parentElement?.closest("li"))
    .map((li) => lines(li))
    .filter((l) => l.length)
    .map((l) => ({ title: l[0], subtitle: l[1], meta: l[2], details: l.slice(3) }));
}

async function readProfile() {
  // Loaded = we are on a real profile and the tab title carries the person's name.
  const name = await waitFor(() => {
    const n = nameFromTitle();
    return location.pathname.startsWith("/in/") && location.pathname !== "/in/me/" && n && n.toLowerCase() !== "linkedin" ? n : null;
  }, 25_000);
  if (!name) throw new Error(`Could not find the profile on the page. ${diagnose()}`);
  await scrollThrough();

  const nameEl = document.querySelector("h1") ?? [...document.querySelectorAll("h1, h2, h3, p, span")].find((e) => clean(e.textContent) === name) ?? null;
  const top = nameEl?.closest("section") ?? document.querySelector("main") ?? document.body;
  const topLines = (top as HTMLElement).innerText.split("\n").map(clean).filter(Boolean);
  const at = topLines.findIndex((l) => l === name || l.startsWith(name));
  const after = at >= 0 ? topLines.slice(at + 1) : topLines;
  const headline = after.find((l) => l.length > 5 && !/^[·•]|^\(?(1st|2nd|3rd)|^(he|she|they)\//i.test(l));
  const place = after.slice(0, 12).find((l) => l !== headline && l.includes(",") && !/followers|connections|contact info/i.test(l));

  const about = sectionByHeading("About") ?? sectionById("about");
  const aboutLines = about ? lines(about).filter((l) => l.toLowerCase() !== "about") : [];

  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  const url = canonical && canonical.includes("/in/") ? canonical : location.origin + location.pathname;

  return {
    url,
    name,
    headline,
    location: place,
    about: aboutLines.sort((a, b) => b.length - a.length)[0],
    experience: entriesIn(findSection("experience", "Experience")),
    education: entriesIn(findSection("education", "Education")),
    skills: entriesIn(findSection("skills", "Skills")).map((e) => e.title),
  };
}

async function readMessages(): Promise<LinkedInThread[]> {
  const first = await waitFor(() => document.querySelector("li.msg-conversation-listitem"));
  if (!first) throw new Error(`Could not find the conversation list on the Messaging page. ${diagnose()}`);
  const items = [...document.querySelectorAll("li.msg-conversation-listitem")].slice(0, MAX_THREADS);
  const threads: LinkedInThread[] = [];

  for (const li of items) {
    const who = clean(li.querySelector(".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names")?.textContent) || lines(li)[0] || "";
    const snippet = clean(li.querySelector(".msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet-body")?.textContent);
    const time = clean(li.querySelector("time")?.textContent);
    const before = document.querySelectorAll(".msg-s-event-listitem").length;

    li.querySelector<HTMLElement>(".msg-conversation-listitem__link, a, [role=button]")?.click();
    await sleep(1_200);
    await waitFor(() => document.querySelectorAll(".msg-s-event-listitem").length !== before || document.querySelector(".msg-s-event-listitem"), 6_000);

    let sender = who;
    const messages: LinkedInMessage[] = [];
    for (const ev of document.querySelectorAll(".msg-s-message-list__event")) {
      const name = clean(ev.querySelector(".msg-s-message-group__name")?.textContent);
      if (name) sender = name;
      const text = clean(ev.querySelector(".msg-s-event-listitem__body")?.textContent);
      if (text) messages.push({ sender, text, time: clean(ev.querySelector("time, .msg-s-message-group__timestamp")?.textContent) || undefined });
    }
    threads.push({ with: who, snippet: snippet || undefined, time: time || undefined, messages });
    await sleep(800);
  }
  return threads;
}

async function readJobs(list: "SAVED" | "APPLIED"): Promise<LinkedInJob[]> {
  await waitFor(() => document.querySelector('a[href*="/jobs/view/"]'), 12_000);
  await scrollThrough();
  const byId = new Map<string, LinkedInJob>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]')) {
    const id = a.href.match(/jobs\/view\/(\d+)/)?.[1];
    if (!id || byId.has(id)) continue;
    const card = a.closest("li") ?? a.parentElement;
    const l = card ? lines(card) : [];
    const title = lines(a)[0] || clean(a.textContent) || l[0];
    if (!title) continue;
    const rest = l.filter((x) => x !== title);
    byId.set(id, { jobId: id, title, company: rest[0], location: rest[1], url: `https://www.linkedin.com/jobs/view/${id}/`, list });
  }
  return [...byId.values()];
}

/** Reads one step on the current page. Throws an Error whose message is shown to the person. */
export async function readStep(key: LinkedInStepKey): Promise<unknown> {
  if (signedOut()) throw new Error("LinkedIn isn't signed in in this browser. Sign in to LinkedIn, then sync again.");
  let data: unknown;
  if (key === "profile") data = await readProfile();
  else if (key === "messages") data = await readMessages();
  else data = await readJobs(key === "jobs-applied" ? "APPLIED" : "SAVED");
  if (signedOut()) throw new Error("LinkedIn asked for a sign-in or verification. Complete it in this browser, then sync again.");
  return data;
}

/** Content-script entry: if this tab is the sync tab, read the current step and hand the result to the background worker. */
export async function runLinkedInSyncIfAsked(send: <T = unknown>(m: Record<string, unknown>) => Promise<T | null>) {
  if (window !== window.top || !/(^|\.)linkedin\.com$/.test(location.hostname)) return;
  const task = await send<{ key: LinkedInStepKey; idx: number } | null>({ type: "liTask" });
  if (!task?.key) return;
  try {
    const data = await readStep(task.key);
    await send({ type: "liResult", idx: task.idx, key: task.key, data });
  } catch (err) {
    await send({ type: "liResult", idx: task.idx, key: task.key, error: err instanceof Error ? err.message : "Could not read LinkedIn" });
  }
}
