/**
 * The form-filling engine of the browser extension (plain DOM, no Playwright). It runs inside the marketer's own
 * browser, so it never drives a page from outside and sites see an ordinary person's browser.
 *
 * Accuracy rules, an application is a statement made on the candidate's behalf:
 *   - Answers come only from the candidate's recorded profile (plus the job and the tailored cover letter). The model
 *     is told to answer null when the profile doesn't say, and every answer is validated here (a choice must be one
 *     of the form's own options).
 *   - Voluntary self-identification questions (gender, race, disability, veteran status...) are never guessed; they
 *     get the form's own "decline to self-identify" option.
 *   - Government/financial identifiers are never filled.
 *   - Legal attestations ("I certify...") are never ticked automatically.
 *   - Nothing here ever clicks Next or Submit: the person does.
 */

export interface AssistCandidate {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  githubUrl?: string;
}

const SKIP_ZONE = 'header, nav, footer, [role="banner"], [role="navigation"], [role="search"], [hidden], [aria-hidden="true"]';

function deepAll<T extends Element>(selector: string, root: ParentNode = document): T[] {
  const found: T[] = Array.from(root.querySelectorAll<T>(selector));
  for (const host of Array.from(root.querySelectorAll("*"))) {
    const shadow = (host as HTMLElement).shadowRoot;
    if (shadow) found.push(...deepAll<T>(selector, shadow));
  }
  return found;
}

// Honeypots: fields that exist only to catch bots. A person never sees or fills them.
function isHoneypot(el: Element) {
  const input = el as HTMLInputElement;
  const ident = `${input.name ?? ""} ${input.id ?? ""} ${el.getAttribute("data-automation-id") ?? ""} ${input.className?.toString?.() ?? ""}`;
  if (/honeypot|honey-pot|beecatcher|bot-?trap|spam-?trap|hp_|_hp|leave.?blank|do.?not.?fill/i.test(ident)) return true;
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const offscreen = r.right < 0 || r.bottom < 0 || r.left > window.innerWidth + 200 || r.top > document.documentElement.scrollHeight + 200;
  const invisible = Number(style.opacity) === 0 || r.width <= 2 || r.height <= 2;
  const unreachable = input.tabIndex === -1 && input.autocomplete === "off";
  return (offscreen || invisible) && (unreachable || el.getAttribute("aria-hidden") === "true");
}

type QuestionKind = "text" | "textarea" | "select" | "radio" | "checkbox" | "checkboxgroup" | "combobox";

export interface FormQuestion {
  id: string;
  kind: QuestionKind;
  inputType: string;
  label: string;
  required: boolean;
  options?: string[];
  placeholder?: string;
  maxLength?: number;
  /** Stable id/name selectors per option (one entry for non-group fields) — used if React re-renders and drops our marker. */
  selectors?: string[];
}

export interface QuestionResult {
  /** Unfilled questions found on the form. */
  asked: number;
  filled: Array<{ label: string; value: string }>;
  skipped: Array<{ label: string; required: boolean; reason: string }>;
  /** Labels of required questions that are still empty — the application must not be submitted. */
  requiredMissing: string[];
  /** Answers a person had saved that were used, and questions saved for a person to answer once. */
  fromSaved: number;
  savedForPerson: number;
  error?: string;
}


/* ── Reading the form ──────────────────────────────────────────────────── */

/** Every shadow-root-aware querySelectorAll. Web-component sites keep their fields inside open shadow roots. */
export function extractQuestions(): FormQuestion[] {
      // Fields of web-component sites (Salesforce-based career pages, some Workday tenants) sit inside shadow roots,
      // which plain document.querySelectorAll cannot see — walk into every open shadow root too.
      const deepAll = <T extends Element>(selector: string, root: ParentNode = document): T[] => {
        const found: T[] = Array.from(root.querySelectorAll<T>(selector));
        for (const host of Array.from(root.querySelectorAll("*"))) {
          const shadow = (host as HTMLElement).shadowRoot;
          if (shadow) found.push(...deepAll<T>(selector, shadow));
        }
        return found;
      };
      const rootOf = (el: Element) => el.getRootNode() as Document | ShadowRoot;

      deepAll("[data-cus-q]").forEach((e) => {
        e.removeAttribute("data-cus-q");
        e.removeAttribute("data-cus-opt");
      });

      const rendered = (el: Element | null | undefined) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const raw = (el: Element | null | undefined) => (((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "") as string).replace(/\s+/g, " ").trim();
      const clean = (t: string) => t.replace(/\s*\*\s*$/, "").replace(/\s*\(required\)\s*$/i, "").trim();

      const SKIP_ZONE = 'header, nav, footer, [role="banner"], [role="navigation"], [role="search"], [hidden], [aria-hidden="true"]';
      const SKIP_NAME = /g-recaptcha-response|h-captcha-response|cf-turnstile|captcha|honeypot|^_?csrf/i;
      // Honeypots: fields that exist only to catch bots (Workday's "beecatcher", hidden "website"/"url" traps).
      // A person never sees or fills them; filling one flags the application as automated.
      const isHoneypot = (el: Element) => {
        const input = el as HTMLInputElement;
        const ident = `${input.name ?? ""} ${input.id ?? ""} ${el.getAttribute("data-automation-id") ?? ""} ${input.className?.toString?.() ?? ""}`;
        if (/honeypot|honey-pot|beecatcher|bot-?trap|spam-?trap|hp_|_hp|leave.?blank|do.?not.?fill/i.test(ident)) return true;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const offscreen = r.right < 0 || r.bottom < 0 || r.left > window.innerWidth + 200 || r.top > document.documentElement.scrollHeight + 200;
        const invisible = Number(style.opacity) === 0 || r.width <= 2 || r.height <= 2;
        const unreachable = input.tabIndex === -1 && input.autocomplete === "off";
        return (offscreen || invisible) && (unreachable || el.getAttribute("aria-hidden") === "true");
      };

      const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "file", "password", "search"]);

      const ownLabel = (el: HTMLInputElement) => {
        if (el.id) {
          const l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l && raw(l)) return raw(l);
        }
        const by = el.getAttribute("aria-labelledby");
        if (by) {
          const t = by.split(/\s+/).map((id) => raw(rootOf(el).getElementById(id))).filter(Boolean).join(" ");
          if (t) return t;
        }
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.trim();
        const wrap = el.closest("label");
        if (wrap && raw(wrap)) return raw(wrap);
        return "";
      };

      // The question text for a field or a radio/checkbox group: the nearest preceding label-like
      // sibling found while climbing out of the field's wrapper.
      const questionText = (el: Element, optionTexts: string[]) => {
        const legend = el.closest("fieldset")?.querySelector("legend");
        if (legend && raw(legend)) return raw(legend);
        const group = el.closest('[role="radiogroup"], [role="group"]');
        const groupLabel = group?.getAttribute("aria-label") || raw(rootOf(el).getElementById(group?.getAttribute("aria-labelledby") ?? ""));
        if (groupLabel) return groupLabel;

        let branch: Element = el;
        for (let depth = 0; depth < 5 && branch.parentElement; depth++) {
          const parent: Element = branch.parentElement;
          const siblings = Array.from(parent.children);
          for (let i = siblings.indexOf(branch) - 1; i >= 0; i--) {
            const t = raw(siblings[i]);
            if (t && t.length <= 400 && !optionTexts.includes(t) && !siblings[i].querySelector("input, select, textarea")) return t;
          }
          branch = parent;
        }
        return "";
      };

      const questions: Array<{
        id: string;
        kind: QuestionKind;
        inputType: string;
        label: string;
        required: boolean;
        options?: string[];
        placeholder?: string;
        maxLength?: number;
        selectors?: string[];
      }> = [];
      const seenGroups = new Map<string, number>();
      let counter = 0;

      const attrSel = (attr: string, value: string) => `[${attr}="${value.replace(/"/g, '\\"')}"]`;
      const selectorFor = (el: Element) => {
        const id = (el as HTMLElement).id;
        if (id && deepAll(attrSel("id", id)).length === 1) return attrSel("id", id);
        const name = el.getAttribute("name");
        if (name && deepAll(attrSel("name", name)).length === 1) return attrSel("name", name);
        return "";
      };
      const mark = (el: Element, id: string, opt?: number) => {
        el.setAttribute("data-cus-q", id);
        if (opt !== undefined) el.setAttribute("data-cus-opt", String(opt));
      };

      const elements = deepAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
      for (const el of elements) {
        if (el.closest(SKIP_ZONE) || el.disabled || isHoneypot(el)) continue;
        const input = el as HTMLInputElement;
        const type = (input.type ?? "").toLowerCase();
        const name = input.name ?? "";
        if (SKIP_TYPES.has(type) || SKIP_NAME.test(name) || SKIP_NAME.test(input.id ?? "")) continue;
        if ((el as HTMLInputElement).readOnly) continue;

        // ── radios & checkboxes ──
        if (type === "radio" || type === "checkbox") {
          const visible = rendered(input) || rendered(input.labels?.[0]) || rendered(input.parentElement);
          if (!visible) continue;

          const groupKey = `${type}:${input.form ? Array.from(document.forms).indexOf(input.form) : "-"}:${name}`;
          const siblings = name ? elements.filter((o) => (o as HTMLInputElement).type === type && (o as HTMLInputElement).name === name && o.closest("form") === input.closest("form")) : [input];
          const isGroup = type === "radio" || siblings.length > 1;

          if (!isGroup) {
            if (input.checked) continue;
            const own = raw(input.closest("label")) || ownLabel(input);
            // A bare "Yes"/"No" checkbox only makes sense together with its question; keep both in the
            // label and mark it ambiguous (see plan()) — ticking "No" is not the same as answering no.
            const q = /^(yes|no)$/i.test(clean(own)) ? `${questionText(input, [own]) || "Checkbox"} [${clean(own)}]` : own || questionText(input, []);
            const id = `q${counter++}`;
            mark(input, id);
            questions.push({
              id,
              kind: "checkbox",
              inputType: "checkbox",
              label: clean(q),
              required: input.required || /\*\s*$/.test(q) || input.getAttribute("aria-required") === "true",
              selectors: [selectorFor(input)],
            });
            continue;
          }

          if (seenGroups.has(groupKey)) continue;
          const optionEls = siblings as HTMLInputElement[];
          if (optionEls.some((o) => o.checked)) {
            seenGroups.set(groupKey, -1);
            continue;
          }
          const optionTexts = optionEls.map((o) => clean(ownLabel(o) || raw(o.nextElementSibling) || raw(o.parentElement)));
          const q = questionText(optionEls[0], optionTexts) || name;
          const id = `q${counter++}`;
          seenGroups.set(groupKey, counter);
          optionEls.forEach((o, i) => mark(o, id, i));
          questions.push({
            id,
            kind: type === "radio" ? "radio" : "checkboxgroup",
            inputType: type,
            label: clean(q),
            required: optionEls.some((o) => o.required) || /\*\s*$/.test(q) || optionEls[0].getAttribute("aria-required") === "true",
            options: optionTexts,
            selectors: optionEls.map((o) => selectorFor(o)),
          });
          continue;
        }

        // ── select ──
        if (el.tagName === "SELECT") {
          const select = el as unknown as HTMLSelectElement;
          if (!rendered(select)) continue;
          const options = Array.from(select.options)
            .map((o) => o.text.replace(/\s+/g, " ").trim())
            .filter((t) => t && !/^(select|choose|please select|--|—)/i.test(t));
          const placeholderSelected = select.selectedIndex <= 0 || !select.value;
          if (!placeholderSelected) continue;
          const q = ownLabel(select as unknown as HTMLInputElement) || questionText(select, options);
          const id = `q${counter++}`;
          mark(select, id);
          questions.push({ id, kind: "select", inputType: "select", label: clean(q), required: select.required || /\*\s*$/.test(q), options, selectors: [selectorFor(select)] });
          continue;
        }

        // ── text-like ──
        if (!rendered(el) || (input.value ?? "").trim() !== "") continue;
        const isCombo = input.getAttribute("role") === "combobox" || input.getAttribute("aria-haspopup") === "listbox" || /select__input/.test(input.className?.toString() ?? "");
        const q = ownLabel(input) || input.placeholder || questionText(input, []);
        const id = `q${counter++}`;
        mark(el, id);
        questions.push({
          id,
          kind: isCombo ? "combobox" : el.tagName === "TEXTAREA" ? "textarea" : "text",
          inputType: type || "textarea",
          label: clean(q),
          required: input.required || input.getAttribute("aria-required") === "true" || /\*\s*$/.test(q),
          placeholder: input.placeholder || undefined,
          maxLength: input.maxLength > 0 && input.maxLength < 100000 ? input.maxLength : undefined,
          selectors: [selectorFor(el)],
        });
      }
      return questions;
}

/* ── 2. Policy: what is never guessed ─────────────────────────────────── */

// Voluntary self-identification (EEO etc.): answered with the form's own decline option, never inferred.
const SELF_ID =
  /\b(gender|sex|race|racial|ethnic\w*|hispanic|latino|latinx|veteran|military|disabilit\w*|sexual orientation|transgender|pronouns?|religio\w*|marital|date of birth|dob|age range|caste)\b/i;
const DECLINE_OPTION = /decline|prefer not|do not wish|don'?t wish|not wish to|choose not|rather not|not to (say|disclose|answer|identify|specify)/i;
// Identifiers we never fill from a model.
const NEVER_FILL = /social security|\bssn\b|aadhaar|aadhar|\bpan (card|number)\b|passport|national id|tax id|bank|account number|credit card|driver'?s? licen[cs]e/i;
// Privacy/terms consent needed just to apply — the candidate authorised the application by enrolling.
const CONSENT = /\b(agree|consent|acknowledge|accept|have read|understand)\b.*\b(privacy|terms|policy|data|processing|conditions|notice|storage|retention|gdpr)\b|^\s*i agree\s*$|^\s*i accept\s*$/i;
// Attestations of truth/eligibility are the candidate's statement to make.
const ATTESTATION = /\b(certify|attest|declare|affirm|swear|under penalty|true and (correct|complete)|accurate and complete)\b/i;

/* ── 3. Where answers come from ───────────────────────────────────────── */

export interface JobInfo {
  title: string;
  company: string;
  description?: string;
}

export interface ModelAnswer {
  id: string;
  answer: string | boolean | string[] | null;
}

/**
 * Everything the form filler needs that lives on the server: the candidate's saved answers, the AI model and the
 * record of questions a person still has to answer. On the server these are direct calls (localAnswerBackend);
 * in the marketer's desktop helper they are API calls, so no database or AI key ever sits on a marketer's PC.
 */
export interface AnswerBackend {
  lookupSaved(asked: Array<{ id: string; label: string }>): Promise<Map<string, { answer: string; savedId: string }>>;
  askModel(questions: FormQuestion[], job: JobInfo, coverLetter?: string): Promise<ModelAnswer[]>;
  markUsed(savedIds: string[]): Promise<void>;
  recordNeeded(questions: Array<{ label: string; options?: string[] }>, askedOn?: string): Promise<number>;
}

/* ── 4. Validate, then fill ───────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The form option an answer refers to, or null — a choice is never invented or approximated loosely. */
export function matchOption(answer: string, options: string[]): number | null {
  const a = norm(answer);
  if (!a) return null;
  const exact = options.findIndex((o) => norm(o) === a);
  if (exact >= 0) return exact;
  if (a === "yes" || a === "no") {
    const idx = options.map((o, i) => (norm(o).split(" ")[0] === a ? i : -1)).filter((i) => i >= 0);
    return idx.length === 1 ? idx[0] : null;
  }
  const partial = options.map((o, i) => (norm(o).includes(a) || a.includes(norm(o)) ? i : -1)).filter((i) => i >= 0 && norm(options[i]).length > 2);
  return partial.length === 1 ? partial[0] : null;
}

export type Planned = { question: FormQuestion; value: string | boolean | number[]; display: string } | { question: FormQuestion; skip: string };

export function plan(question: FormQuestion, model: ModelAnswer | undefined, fromPerson = false): Planned {
  const label = question.label;
  const skip = (reason: string): Planned => ({ question, skip: reason });

  if (NEVER_FILL.test(label)) return skip("government/financial identifier — never filled automatically");

  if (question.kind === "checkbox") {
    if (/\[(yes|no)\]$/i.test(label)) return skip("bare Yes/No checkbox — ambiguous, left for a human");
    if (ATTESTATION.test(label)) return skip("legal attestation — must be confirmed by the candidate");
    if (CONSENT.test(label)) return { question, value: true, display: "ticked (privacy/terms consent)" };
    if (model?.answer === true) return { question, value: true, display: "ticked" };
    return skip(model?.answer === false ? "answered no" : "not answerable from the profile");
  }

  // A person chose this answer for this candidate, so it is used as given — otherwise voluntary
  // self-identification questions get the form's own "decline" option, never a guess.
  const hasChoices = question.kind === "select" || question.kind === "radio" || (question.kind === "combobox" && !!question.options?.length);
  if (!fromPerson && hasChoices && SELF_ID.test(label)) {
    const decline = (question.options ?? []).findIndex((o) => DECLINE_OPTION.test(o));
    return decline >= 0 ? { question, value: [decline], display: `${question.options![decline]} (voluntary self-identification)` } : skip("voluntary self-identification with no decline option");
  }
  if (!fromPerson && SELF_ID.test(label)) return skip("voluntary self-identification — not answered");

  const answer = model?.answer;
  if (answer === null || answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0)) return skip("the profile doesn't say");

  if (hasChoices) {
    let idx = matchOption(String(Array.isArray(answer) ? answer[0] : answer), question.options ?? []);
    if (idx === null) {
      // The question may say which option to use when yours isn't listed: select "Other (School Not Listed)" if ...
      const stated = label.match(/(?:select|choose|pick)\s+[“"']([^“"']{2,70})[”"']/i)?.[1];
      if (stated) idx = matchOption(stated, question.options ?? []);
    }
    return idx === null ? skip(`answer "${String(answer).slice(0, 40)}" is not one of the form's options`) : { question, value: [idx], display: question.options![idx] };
  }
  if (question.kind === "checkboxgroup") {
    const wanted = (Array.isArray(answer) ? answer : [String(answer)]).map((a) => matchOption(String(a), question.options ?? []));
    const picked = wanted.filter((i): i is number => i !== null);
    return picked.length === 0 ? skip("no matching options") : { question, value: picked, display: picked.map((i) => question.options![i]).join(", ") };
  }

  let text = String(Array.isArray(answer) ? answer.join(", ") : answer).trim();
  if (question.inputType === "number") {
    text = text.replace(/[^\d.]/g, "");
    if (!text) return skip("not a number");
  }
  if (question.inputType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return skip("date not in YYYY-MM-DD");
  if (question.maxLength && text.length > question.maxLength) return skip(`answer longer than the field's ${question.maxLength}-character limit`);
  return { question, value: text, display: text.length > 60 ? `${text.slice(0, 57)}…` : text };
}


/** True when this document (frame) shows a real application form, not a job page that merely has inputs somewhere. */
export function hasVisibleForm(): boolean {
      const isRendered = (el: Element) => {
        if (el.getClientRects().length === 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      };
      const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "search"]);
      const NOISE = /search|keyword|newsletter|subscribe|coupon|captcha|cookie|consent|filter/i;
      const IDENTITY = /name|e-?mail|phone|mobile|resume|cv|linkedin/i;

      // Sites built on web components (Salesforce-based career sites, some Workday tenants) keep their fields inside
      // shadow roots, which document.querySelectorAll cannot see. Walk into every open shadow root as well.
      const deepAll = <T extends Element>(selector: string, root: ParentNode = document): T[] => {
        const found: T[] = Array.from(root.querySelectorAll<T>(selector));
        for (const host of Array.from(root.querySelectorAll("*"))) {
          const shadow = (host as HTMLElement).shadowRoot;
          if (shadow) found.push(...deepAll<T>(selector, shadow));
        }
        return found;
      };

      const looksLikeHoneypot = (el: Element) => /honeypot|honey-pot|beecatcher|bot-?trap|spam-?trap/i.test(`${(el as HTMLInputElement).name ?? ""} ${el.id ?? ""} ${el.getAttribute("data-automation-id") ?? ""}`);
      const groups = new Map<Element | ShadowRoot | null, { fields: number; identity: boolean; file: boolean; password: boolean }>();
      for (const el of deepAll<HTMLInputElement>("input, textarea, select")) {
        if (el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="search"], [aria-hidden="true"], [hidden]') || looksLikeHoneypot(el)) continue;
        // Fields inside the same shadow root belong together even when there is no <form> element around them.
        const root = el.getRootNode();
        const form = el.closest("form") ?? (root instanceof ShadowRoot ? root : null);
        const group = groups.get(form) ?? { fields: 0, identity: false, file: false, password: false };
        groups.set(form, group);

        const type = (el.type ?? "").toLowerCase();
        if (type === "password") {
          if (isRendered(el)) group.password = true;
          continue;
        }
        if (type === "file") {
          // File inputs are routinely visually hidden behind a custom button, so judge the
          // surrounding form (or the page) instead of the input itself.
          if (!form || form instanceof ShadowRoot || isRendered(form)) group.file = true;
          continue;
        }
        if (SKIP_TYPES.has(type) || !isRendered(el)) continue;

        const descriptor = [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].join(" ");
        if (NOISE.test(descriptor)) continue;
        group.fields++;
        if (type === "email" || type === "tel" || IDENTITY.test(descriptor)) group.identity = true;
      }

      for (const group of groups.values()) {
        if (group.password && !group.file) continue;
        if (group.file || group.fields >= 3 || (group.fields >= 2 && group.identity)) return true;
      }
      return false;
}


/* ── Filling: plain DOM, runs inside the browser extension's content script ───────────── */

const rendered = (el: Element | null | undefined) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";

/** Sets a value the way a person typing would, so React/Vue-controlled inputs notice it. */
export function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

export function setFileOnInput(input: HTMLInputElement, file: File) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

type AtsType = "GREENHOUSE" | "LEVER" | "WORKDAY" | "TALEO" | "ASHBY" | "GENERIC";

function detectAts(url: string): AtsType {
  const host = url.toLowerCase();
  if (host.includes("greenhouse.io")) return "GREENHOUSE";
  if (host.includes("lever.co")) return "LEVER";
  if (host.includes("myworkdayjobs.com") || host.includes("workday.com")) return "WORKDAY";
  if (host.includes("taleo.net")) return "TALEO";
  if (host.includes("ashbyhq.com")) return "ASHBY";
  return "GENERIC";
}

// Ordered candidate selectors per field, per known ATS. The generic list covers everything else.
const SELECTORS: Record<AtsType, Record<string, string[]>> = {
  GREENHOUSE: {
    firstName: ["#first_name"],
    lastName: ["#last_name"],
    email: ["#email"],
    phone: ["#phone"],
    linkedin: ['input[name*="linkedin" i]'],
    portfolio: ['input[name*="website" i]', 'input[name*="portfolio" i]'],
    resumeFile: ['input[type="file"][name*="resume" i]', 'input[type="file"]'],
  },
  LEVER: {
    fullName: ['input[name="name"]'],
    email: ['input[name="email"]'],
    phone: ['input[name="phone"]'],
    linkedin: ['input[name="urls[LinkedIn]"]'],
    portfolio: ['input[name="urls[Portfolio]"]', 'input[name="urls[Website]"]'],
    resumeFile: ['input[name="resume"]', 'input[type="file"]'],
  },
  WORKDAY: {
    firstName: ['input[data-automation-id*="firstName" i]'],
    lastName: ['input[data-automation-id*="lastName" i]'],
    email: ['input[data-automation-id*="email" i]'],
    phone: ['input[data-automation-id*="phone" i]'],
    resumeFile: ['input[type="file"][data-automation-id*="resume" i]', 'input[type="file"]'],
  },
  ASHBY: {
    fullName: ['input[name="_systemfield_name"]'],
    email: ['input[name="_systemfield_email"]'],
    phone: ['input[type="tel"]'],
    resumeFile: ['input[type="file"]'],
  },
  TALEO: {
    firstName: ['input[id*="firstName" i]'],
    lastName: ['input[id*="lastName" i]'],
    email: ['input[id*="email" i]'],
    phone: ['input[id*="phone" i]'],
    resumeFile: ['input[type="file"]'],
  },
  GENERIC: {
    fullName: ['input[autocomplete="name"]', 'input[name="name" i]', 'input[id="name" i]', 'input[name*="full_name" i]', 'input[name*="fullname" i]'],
    firstName: ['input[autocomplete="given-name"]', 'input[name*="first_name" i]', 'input[name*="firstname" i]'],
    lastName: ['input[autocomplete="family-name"]', 'input[name*="last_name" i]', 'input[name*="lastname" i]'],
    email: ['input[type="email"]', 'input[name*="email" i]'],
    phone: ['input[type="tel"]', 'input[name*="phone" i]'],
    linkedin: ['input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]'],
    portfolio: ['input[name*="portfolio" i]', 'input[name*="website" i]'],
    github: ['input[name*="github" i]', 'input[placeholder*="github" i]'],
    resumeFile: [
      'input[type="file"][name*="resume" i]',
      'input[type="file"][name*="cv" i]',
      'input[type="file"][id*="resume" i]',
      'input[type="file"][aria-label*="resume" i]',
      'input[type="file"]',
    ],
  },
};

/** The first visible, still-empty text field matching one of the selectors. A field a person already typed in is never overwritten. */
function firstEmptyField(selectors: string[]): HTMLInputElement | null {
  for (const selector of selectors) {
    for (const el of deepAll<HTMLInputElement>(selector)) {
      if (el.disabled || el.readOnly || !rendered(el) || el.closest(SKIP_ZONE) || isHoneypot(el)) continue;
      if ((el.value ?? "").trim() === "") return el;
    }
  }
  return null;
}

export interface FillResult {
  ats: string;
  filled: string[];
  resumeAttached: boolean;
}

/** The fixed fields every application has (name, email, phone, links, resume). Everything else goes through runQuestions. */
export function fillBasics(candidate: AssistCandidate, resume: File | null): FillResult {
  const ats = detectAts(location.href);
  const fields = { ...SELECTORS.GENERIC, ...SELECTORS[ats] };
  const filled: string[] = [];
  const put = (key: string, value: string | undefined) => {
    if (!value || !fields[key]) return;
    const el = firstEmptyField([...(SELECTORS[ats][key] ?? []), ...(SELECTORS.GENERIC[key] ?? [])]);
    if (el) {
      setFieldValue(el, value);
      filled.push(key);
    }
  };
  const [firstName, ...rest] = candidate.name.trim().split(/\s+/);
  put("fullName", candidate.name);
  put("firstName", firstName);
  put("lastName", rest.join(" ") || firstName);
  put("email", candidate.email);
  put("phone", candidate.phone);
  put("linkedin", candidate.linkedinUrl);
  put("portfolio", candidate.portfolioUrl);
  put("github", candidate.githubUrl);

  let resumeAttached = false;
  if (resume) {
    for (const selector of [...(SELECTORS[ats].resumeFile ?? []), ...SELECTORS.GENERIC.resumeFile]) {
      const input = deepAll<HTMLInputElement>(selector).find((el) => !el.disabled && (el.files?.length ?? 0) === 0 && !isCoverLetterInput(el));
      if (input) {
        setFileOnInput(input, resume);
        resumeAttached = true;
        break;
      }
    }
  }
  return { ats, filled, resumeAttached };
}

/** A file input that is for the cover letter (or anything other than a resume) must not receive the resume. */
function isCoverLetterInput(input: HTMLInputElement) {
  const text = `${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""} ${input.closest("label, div")?.textContent?.slice(0, 80) ?? ""}`;
  return /cover.?letter|portfolio|transcript|certificate|photo/i.test(text) && !/resume|cv/i.test(text);
}

/** True once a visible file input that wants the resume exists on a page (an "upload your resume" step). */
export function attachResumeToUploadStep(resume: File): boolean {
  const input = deepAll<HTMLInputElement>('input[type="file"]').find((el) => !el.disabled && (el.files?.length ?? 0) === 0 && !isCoverLetterInput(el));
  if (!input) return false;
  setFileOnInput(input, resume);
  return true;
}

/** Writes one planned answer into the page. Custom dropdowns are left for the person: they can't be driven reliably. */
function applyPlanned(p: Extract<Planned, { value: unknown }>): { ok: boolean; reason?: string } {
  const { question, value } = p;
  const find = (option?: number): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null => {
    const sel = option === undefined ? `[data-cus-q="${question.id}"]` : `[data-cus-q="${question.id}"][data-cus-opt="${option}"]`;
    const marked = deepAll<HTMLInputElement>(sel)[0];
    if (marked) return marked;
    const stable = question.selectors?.[option ?? 0];
    return stable ? (deepAll<HTMLInputElement>(stable)[0] ?? null) : null;
  };

  try {
    if (question.kind === "combobox") return { ok: false, reason: "custom dropdown: choose it yourself" };
    const el = find();
    if (!el && question.kind !== "radio" && question.kind !== "checkboxgroup") return { ok: false, reason: "the field changed on the page" };

    if (question.kind === "text" || question.kind === "textarea") {
      setFieldValue(el as HTMLInputElement, String(value));
      return { ok: (el as HTMLInputElement).value.trim() !== "" };
    }
    if (question.kind === "select") {
      const select = el as HTMLSelectElement;
      const wanted = question.options![(value as number[])[0]];
      const option = Array.from(select.options).find((o) => o.text.replace(/\s+/g, " ").trim() === wanted);
      if (!option) return { ok: false, reason: "option not found" };
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: select.selectedIndex > 0 };
    }
    if (question.kind === "radio" || question.kind === "checkboxgroup" || question.kind === "checkbox") {
      const indexes = question.kind === "checkbox" ? [undefined] : (value as number[]);
      for (const i of indexes) {
        const option = (i === undefined ? el : find(i)) as HTMLInputElement | null;
        if (!option) return { ok: false, reason: "option not found" };
        if (!option.checked) {
          option.click();
          // Custom-styled controls hide the real input behind a label: click that instead.
          if (!option.checked) (option.labels?.[0] ?? option.parentElement)?.click();
        }
        if (!option.checked) return { ok: false, reason: "the page ignored the click" };
      }
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "failed" };
  }
  return { ok: false, reason: "unsupported field" };
}

/**
 * Finds the unanswered questions on the current form and answers what the candidate's profile supports (saved
 * answers first, then the AI via the portal). `requiredMissing` lists required questions left empty for the person.
 */
export async function runQuestions(job: JobInfo, coverLetter: string | undefined, backend: AnswerBackend): Promise<QuestionResult> {
  const result: QuestionResult = { asked: 0, filled: [], skipped: [], requiredMissing: [], fromSaved: 0, savedForPerson: 0 };
  const questions = extractQuestions().filter((q) => q.label || q.kind === "checkbox");
  result.asked = questions.length;
  if (questions.length === 0) return result;

  const saved = await backend.lookupSaved(questions.filter((q) => !NEVER_FILL.test(q.label)).map((q) => ({ id: q.id, label: q.label }))).catch(() => new Map<string, { answer: string; savedId: string }>());

  const askable = questions.filter(
    (q) =>
      q.kind !== "combobox" &&
      !saved.has(q.id) &&
      !NEVER_FILL.test(q.label) &&
      !SELF_ID.test(q.label) &&
      !(q.kind === "checkbox" && (CONSENT.test(q.label) || ATTESTATION.test(q.label) || /\[(yes|no)\]$/i.test(q.label)))
  );
  let answers: ModelAnswer[] = [];
  if (askable.length > 0) {
    try {
      answers = await backend.askModel(askable, job, coverLetter);
    } catch (err) {
      result.error = `AI question-answering unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const byId = new Map<string, ModelAnswer>(answers.map((a) => [a.id, a]));
  for (const [id, hit] of saved) byId.set(id, { id, answer: hit.answer });

  const usedSaved: string[] = [];
  const needed: Array<{ label: string; options?: string[] }> = [];
  const ANSWERABLE_BY_PERSON = /the profile doesn't say|not one of the form's options|no matching options|not answerable from the profile/;

  for (const question of questions) {
    const person = saved.get(question.id);
    const planned = plan(question, byId.get(question.id), !!person);
    if ("skip" in planned) {
      result.skipped.push({ label: question.label, required: question.required, reason: planned.skip });
      if (question.required) {
        result.requiredMissing.push(question.label || "(unlabelled required field)");
        if (ANSWERABLE_BY_PERSON.test(planned.skip) && question.label) needed.push({ label: question.label, options: question.options });
      }
      continue;
    }
    const applied = applyPlanned(planned);
    if (applied.ok) {
      result.filled.push({ label: question.label, value: planned.display });
      if (person) {
        usedSaved.push(person.savedId);
        result.fromSaved++;
      }
    } else {
      result.skipped.push({ label: question.label, required: question.required, reason: applied.reason ?? "the form rejected or ignored the value" });
      if (question.required) result.requiredMissing.push(question.label || "(unlabelled required field)");
    }
  }

  await backend.markUsed(usedSaved).catch(() => undefined);
  if (needed.length > 0) result.savedForPerson = await backend.recordNeeded(needed, location.hostname).catch(() => 0);
  return result;
}

export function summarizeQuestionResult(r: QuestionResult): string {
  const parts = [`${r.filled.length}/${r.asked} answered${r.fromSaved ? ` (${r.fromSaved} from saved answers)` : ""}`];
  if (r.filled.length) parts.push(`filled: ${r.filled.map((f) => `"${f.label}" → ${f.value}`).join("; ")}`);
  const optional = r.skipped.filter((s) => !s.required);
  if (optional.length) parts.push(`left blank (optional): ${optional.map((s) => `"${s.label}" (${s.reason})`).join("; ")}`);
  if (r.requiredMissing.length) parts.push(`REQUIRED but unanswered: ${r.skipped.filter((s) => s.required).map((s) => `"${s.label}" (${s.reason})`).join("; ")}`);
  if (r.savedForPerson) parts.push(`${r.savedForPerson} new question(s) saved under the candidate's "Saved answers" for a person to answer once`);
  if (r.error) parts.push(r.error);
  return parts.join(" | ");
}

/** A short description of why this page is the employer's "application received" page, or null. Only a positive signal counts. */
export function submissionEvidence(): string | null {
  const url = location.href.toLowerCase();
  if (/greenhouse\.io/.test(url) && /\/confirmation\b/.test(url)) return "Greenhouse confirmation page";
  if (/lever\.co/.test(url) && /\/thanks\b/.test(url)) return "Lever confirmation page";
  if (/thank|confirmation|success|submitted|complete/.test(url)) {
    const text = document.body?.innerText ?? "";
    if (CONFIRMATION_TEXT.test(text)) return "confirmation page";
    return null; // a URL word alone ("complete-your-profile") is not enough
  }
  return CONFIRMATION_TEXT.test(document.body?.innerText ?? "") ? "confirmation page" : null;
}

const CONFIRMATION_TEXT = /thank you for (applying|your application|your interest)|application (has been |was |is )?(received|submitted|complete)|we('ve| have) received your application|(your application (has been )?)?submitted successfully/i;
