import {
  attachResumeToUploadStep,
  fillBasics,
  hasVisibleForm,
  runQuestions,
  submissionEvidence,
  summarizeQuestionResult,
  type AnswerBackend,
  type AssistCandidate,
  type JobInfo,
} from "../../lib/automation/formEngine";

/**
 * CUS Assist, the page side. It does two things and nothing else:
 *   1. On the portal's own pages it relays "connect" / "apply" requests to the background worker.
 *   2. On pages that belong to an application the marketer started, it watches for forms and fills them in.
 * It never clicks Next or Submit, and does nothing at all on pages outside those two cases.
 */

const isTop = window === window.top;
const POLL_MS = 1_500;

const send = <T = unknown>(message: Record<string, unknown>): Promise<T | null> =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : (response as T)));
    } catch {
      resolve(null); // the extension was reloaded under an open tab
    }
  });

/* ── 1. Portal bridge ─────────────────────────────────────────────────── */

if (isTop) {
  const reply = (type: string, payload: Record<string, unknown> = {}) => window.postMessage({ source: "cus-assist", type, ...payload }, location.origin);
  window.addEventListener("message", async (event) => {
    const data = event.data as { source?: string; type?: string; token?: string; applicationId?: string } | null;
    if (event.source !== window || data?.source !== "cus-portal") return;

    if (data.type === "PING") {
      const r = await send<{ paired: boolean }>({ type: "ping" });
      reply("PONG", { paired: !!r?.paired });
    } else if (data.type === "PAIR" && data.token) {
      // Any website could send this message, so the person always has to confirm which site they are connecting to.
      if (!confirm(`Connect CUS Assist to ${location.origin}?\n\nOnly click OK if you just pressed "Connect extension" in your company's portal.`)) return reply("PAIRED", { ok: false });
      const r = await send<{ ok: boolean }>({ type: "pair", token: data.token });
      reply("PAIRED", { ok: !!r?.ok });
    } else if (data.type === "APPLY" && data.applicationId) {
      const r = await send<{ ok: boolean; error?: string }>({ type: "apply", applicationId: data.applicationId });
      reply("APPLY_RESULT", { applicationId: data.applicationId, ok: !!r?.ok, error: r?.ok ? undefined : (r?.error ?? "The extension didn't answer. Reload the portal page.") });
    }
  });
}

/* ── 2. Application session ───────────────────────────────────────────── */

interface SessionInfo {
  applicationId: string;
  candidate: AssistCandidate;
  job: JobInfo;
  coverLetter?: string;
  quickCopy: Array<{ label: string; value: string }>;
  filled: boolean;
  resumeAttached: boolean;
  submitted: boolean;
}

const backend: AnswerBackend = {
  async lookupSaved(asked) {
    const r = await send<{ answers: Array<{ id: string; answer: string; savedId: string }> }>({ type: "answers", body: { action: "lookup", asked } });
    return new Map((r?.answers ?? []).map((a) => [a.id, { answer: a.answer, savedId: a.savedId }]));
  },
  async askModel(questions, job, coverLetter) {
    const r = await send<{ answers?: Array<{ id: string; answer: string | boolean | string[] | null }>; error?: string }>({ type: "answers", body: { action: "ask", questions, job, coverLetter } });
    if (!r?.answers) throw new Error(r?.error ?? "the portal didn't answer");
    return r.answers;
  },
  async markUsed(savedIds) {
    await send({ type: "answers", body: { action: "used", savedIds } });
  },
  async recordNeeded(questions, askedOn) {
    return (await send<{ created: number }>({ type: "answers", body: { action: "needed", questions, askedOn } }))?.created ?? 0;
  },
};

let resumeFile: Promise<File | null> | null = null;
function getResume(): Promise<File | null> {
  resumeFile ??= send<{ name: string; base64: string }>({ type: "resume" }).then((r) => {
    if (!r?.base64) return null;
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    return new File([bytes], r.name || "resume.pdf", { type: "application/pdf" });
  });
  return resumeFile;
}

/* The bar in the corner. It lives in a closed shadow root so the site's CSS and scripts can't touch it. */
let setStatus: (text: string) => void = () => undefined;

function mountBar(quickCopy: Array<{ label: string; value: string }>) {
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const el = (tag: string, css: string, text?: string) => {
    const e = document.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  };
  const BTN = "border:0;border-radius:6px;padding:6px 10px;font:600 12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;color:#fff;";
  const box = el("div", "background:#0f172a;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);width:340px;display:flex;flex-direction:column;gap:8px");
  const text = el("div", "", "CUS Assist is watching this page");
  setStatus = (t) => (text.textContent = t);

  const row = el("div", "display:flex;gap:6px;flex-wrap:wrap");
  const fill = el("button", `${BTN}background:#2563eb`, "Fill with AI");
  fill.onclick = () => void send({ type: "forceFill" });
  const quick = el("button", `${BTN}background:#334155`, "Quick copy");
  const applied = el("button", `${BTN}background:#16a34a`, "Mark as applied");
  applied.onclick = async () => {
    if (!confirm("Record this application as submitted?")) return;
    await send({ type: "submitted", evidence: "marked as applied by the marketer" });
    setStatus("Recorded as applied. You can close this tab.");
  };
  row.append(fill, quick, applied);

  const panel = el("div", "display:none;flex-direction:column;gap:4px;max-height:280px;overflow:auto;border-top:1px solid #334155;padding-top:8px");
  quick.onclick = () => (panel.style.display = panel.style.display === "none" ? "flex" : "none");
  for (const item of quickCopy) {
    const r = el("div", "display:flex;gap:8px;align-items:center;justify-content:space-between");
    const label = el("div", "min-width:0;flex:1");
    label.append(el("div", "font-weight:600;font-size:12px", item.label), el("div", "color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", item.value.replace(/\s+/g, " ").slice(0, 60)));
    const copy = el("button", `${BTN}background:#334155`, "Copy");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(item.value);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = item.value;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 900);
    };
    r.append(label, copy);
    panel.append(r);
  }
  box.append(text, row, panel);
  root.append(box);
  document.documentElement.appendChild(host);
  // A single-page app can wipe the page; put the bar back if that happens.
  setInterval(() => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }, 1500);
}

async function runSession(info: SessionInfo) {
  const say = (text: string) => (isTop ? setStatus(text) : void send({ type: "status", text }));
  const step = (name: string, status: "STARTED" | "SUCCESS" | "FAILED" | "SKIPPED", message?: string) => void send({ type: "step", step: name, status, message });

  let busy = false;
  let filledAnything = info.filled;
  let submitted = info.submitted;
  let lastFilled = "";
  let seen = { fingerprint: "", stable: 0 };
  let uploadTried = false;
  // The resume goes in once per application. A site that accepted it clears the file input, so "empty input" does not
  // mean "not uploaded"; without this memory every new step would upload the same file again.
  let resumeDone = info.resumeAttached;
  const markResumeDone = () => {
    resumeDone = true;
    void send({ type: "resumeAttached" });
  };

  /** What fields are on show, so a new wizard step counts as new and an unchanged one is left alone. */
  const fingerprint = () =>
    location.pathname +
    "#" +
    Array.from(document.querySelectorAll<HTMLInputElement>("input, select, textarea"))
      .filter((el) => el.getClientRects().length > 0 && !["hidden", "submit", "button"].includes((el.type ?? "").toLowerCase()))
      .map((el) => `${el.tagName}:${el.type}:${el.name || el.id}`)
      .join("|");

  async function fillForm(fp: string, force = false) {
    say("Filling this step…");
    lastFilled = fp;
    const resume = !resumeDone || force ? await getResume() : null;
    const basics = fillBasics(info.candidate, resume);
    if (basics.resumeAttached) markResumeDone();
    const questions = await runQuestions(info.job, info.coverLetter, backend);
    filledAnything = true;
    void send({ type: "filled" });
    step("fill_form", "SUCCESS", `${basics.ats}: ${basics.filled.length} basic field(s), resume ${basics.resumeAttached ? "attached" : "not attached"}`);
    if (questions.asked > 0) step("answer_questions", questions.requiredMissing.length ? "FAILED" : "SUCCESS", summarizeQuestionResult(questions));
    const todo = questions.requiredMissing.length;
    say(todo > 0 ? `Filled what I could. ${todo} required answer(s) need you: ${questions.requiredMissing.slice(0, 3).join("; ")}${todo > 3 ? "…" : ""}` : "Filled in. Check everything, then press Next / Submit yourself.");
  }

  async function inspect(force: boolean) {
    if (submitted) return;
    if (hasVisibleForm()) {
      const fp = fingerprint();
      if (force) return fillForm(fp, true);
      if (lastFilled === fp) return;
      // Forms render in stages; wait until the fields stop changing before filling.
      seen = seen.fingerprint === fp ? { fingerprint: fp, stable: seen.stable + 1 } : { fingerprint: fp, stable: 1 };
      if (seen.stable >= 2) await fillForm(fp);
      return;
    }
    // No form: either the employer's confirmation page, or an upload-only step.
    if (filledAnything) {
      const evidence = submissionEvidence();
      if (evidence) {
        submitted = true;
        await send({ type: "submitted", evidence });
        say("Application recorded as applied. You can close this tab.");
        return;
      }
    }
    if (force || (!uploadTried && !resumeDone)) {
      uploadTried = true;
      const resume = await getResume();
      if (resume && attachResumeToUploadStep(resume)) {
        markResumeDone();
        filledAnything = true;
        void send({ type: "filled" });
        step("attach_resume", "SUCCESS", "Attached the tailored resume on an upload step");
        say("Tailored resume attached.");
      } else if (force && isTop) {
        say("No form on this page yet. Click Apply / continue, and I will fill it when it appears.");
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "doFill") {
      void (async () => {
        if (busy) return;
        busy = true;
        await inspect(true).catch(() => undefined);
        busy = false;
      })();
    } else if (message?.type === "showStatus" && isTop) {
      setStatus(String(message.text));
    }
  });

  if (isTop) {
    mountBar(info.quickCopy);
    say("Click Apply / sign in as usual. I will fill the form when it shows up.");
  }
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await inspect(false);
    } catch (err) {
      step("watch", "FAILED", err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

async function boot() {
  // A tab opened by a link on the page can be registered a moment after its content script starts, so ask a few times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const info = await send<SessionInfo | null>({ type: "session" });
    if (info) return runSession(info);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
void boot();
