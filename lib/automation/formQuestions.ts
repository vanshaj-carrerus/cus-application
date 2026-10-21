import type { Frame, Page } from "playwright";
import type { ICandidate } from "@/lib/models/Candidate";
import { runJsonPrompt } from "@/lib/adapters/multiProviderAdapter";
import { chooseComboboxOption, pickAutocompleteSuggestion, readComboboxOptions } from "@/lib/automation/combobox";
import { lookupSavedAnswers, markAnswersUsed, recordNeededQuestions } from "@/lib/automation/savedAnswers";

/**
 * Answers the questions on an application form that the fixed selectors in formHeuristics.ts
 * don't cover (work authorization, salary, notice period, address, "why this role", consent
 * checkboxes...).
 *
 * Accuracy rules — an application is a statement made on the candidate's behalf, so:
 *   - Answers come only from the candidate's recorded profile (plus the job and the tailored
 *     cover letter). The model is told to answer null when the profile doesn't say, and every
 *     answer is validated in code (a choice must be one of the form's own options).
 *   - Voluntary self-identification questions (gender, race, disability, veteran status...) are
 *     never answered from a guess; they get the form's own "decline to self-identify" option.
 *   - Government/financial identifiers are never filled.
 *   - Legal attestations ("I certify...") are never ticked automatically.
 *   - A required question that ends up unanswered is reported, so the caller can stop and hand
 *     the application to a human *before* submitting anything incomplete.
 */

type Interactable = Page | Frame;

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

/* ── 1. Read the form ─────────────────────────────────────────────────── */

async function extractQuestions(ctx: Interactable): Promise<FormQuestion[]> {
  return ctx
    .evaluate(() => {
      // tsx/esbuild wraps named inner functions in a __name() helper that doesn't exist in the browser.
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;

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
        kind: string;
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
    })
    .then((qs) => qs as FormQuestion[])
    .catch(() => []);
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

/* ── 3. Ask the model, with only the profile as source ────────────────── */

interface JobInfo {
  title: string;
  company: string;
  description?: string;
}

function buildFacts(candidate: ICandidate) {
  const current = candidate.experience?.find((e) => e.isCurrent) ?? candidate.experience?.[0];
  const education = candidate.education?.[0];
  const a = candidate.address;
  // Blank (or whitespace-only) means "not specified" — it must reach the model as absent, not as an empty answer.
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const hasAddress = !!a && [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].some((v) => text(v));
  return {
    fullName: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    location: candidate.location,
    address: hasAddress ? { line1: text(a?.line1), line2: text(a?.line2), city: text(a?.city), state: text(a?.state), postalCode: text(a?.postalCode), country: text(a?.country) } : undefined,
    currentOrLastEmployer: current?.company,
    currentOrLastTitle: current?.title,
    totalYearsOfExperience: candidate.yearsOfExperience ?? candidate.aiProfile?.yearsOfExperience,
    careerLevel: candidate.careerLevel,
    education: education ? { institution: education.institution, degree: education.degree, field: education.field } : undefined,
    skills: [...new Set([...(candidate.technicalSkills ?? []), ...(candidate.skills ?? [])])].slice(0, 40),
    experienceSummary: (candidate.experience ?? []).slice(0, 6).map((e) => ({ title: e.title, company: e.company, from: e.startDate, to: e.isCurrent ? "present" : e.endDate, about: e.description?.slice(0, 220) })),
    noticePeriod: text(candidate.noticePeriod),
    expectedSalary: candidate.expectedSalary ? `${candidate.expectedSalary}${candidate.currency ? " " + candidate.currency : ""}` : undefined,
    workAuthorization: text(candidate.workAuthorization),
    requiresVisaSponsorship: bool(candidate.requiresSponsorship),
    willingToRelocate: bool(candidate.willingToRelocate),
    linkedinUrl: text(candidate.linkedinUrl),
    portfolioUrl: text(candidate.portfolioUrl),
    githubUrl: text(candidate.githubUrl),
    professionalSummary: candidate.aiProfile?.overview ?? candidate.aiProfile?.headline,
  };
}

interface ModelAnswer {
  id: string;
  answer: string | boolean | string[] | null;
}

async function askModel(questions: FormQuestion[], candidate: ICandidate, job: JobInfo, coverLetter?: string): Promise<ModelAnswer[]> {
  const prompt = `You are completing a job application form on behalf of a candidate. The answers will be submitted to the employer exactly as you write them, so accuracy matters more than completeness.

RULES
1. Use ONLY the CANDIDATE FACTS below (and the job details / cover letter for free-text answers). Never invent or assume a fact.
2. If the facts do not clearly answer a question, answer null. A null is correct and expected; a wrong answer is not.
3. For select/radio questions the answer must be copied exactly from that question's "options". For checkboxgroup, answer an array of options. For a single checkbox answer true or false. Everything else is a string.
4. Respect "maxLength" when present, and "inputType" (number -> digits only; date -> YYYY-MM-DD; url -> a full URL taken from the facts).
5. Years of experience with a specific skill: only answer if the experience entries clearly show it; otherwise null.
6. Yes/no eligibility questions (work authorization, visa sponsorship, relocation, notice period): answer only from the matching fact; null if the fact is absent.
7. Open-ended text (motivation, "why this role/company", strengths, additional information, cover letter) is NOT a fact lookup — always write it: 2-4 truthful sentences that connect the candidate's real experience and skills to the job details, claiming nothing the facts don't support. If a cover letter is provided and the field asks for a cover letter, use it verbatim.
8. "How did you hear about this role": for free text answer "Online job posting"; when there are options, choose the closest one (job board / online job posting / website / internet search), and "Other" only if none fits.
10. A question whose "kind" is "combobox" and that has NO "options" is a search box: answer with the short text to search for — a country name, or "City, State" / "City, Country" for a location (taken from the candidate's address, else their location).
11. If the question text itself says which option to choose in some case (for example 'select "Other" if your school is not listed'), follow it. For a school/university question, use the candidate's education institution when it is among the options, otherwise the option the question says to use.
9. Salary questions: use expectedSalary if present, else null.

CANDIDATE FACTS
${JSON.stringify(buildFacts(candidate), null, 1)}

JOB
${JSON.stringify({ title: job.title, company: job.company, description: job.description?.slice(0, 1500) })}
${coverLetter ? `\nCOVER LETTER (tailored for this job)\n${coverLetter.slice(0, 3000)}\n` : ""}
QUESTIONS (JSON)
${JSON.stringify(questions.map((q) => ({ id: q.id, question: q.label, kind: q.kind, inputType: q.inputType, required: q.required, options: q.options, maxLength: q.maxLength, placeholder: q.placeholder })), null, 1)}

Respond with ONLY this JSON, one entry per question id:
{"answers":[{"id":"q0","answer":<string | boolean | string[] | null>}]}`;

  const { data } = await runJsonPrompt<{ answers?: ModelAnswer[] }>(prompt);
  return Array.isArray(data.answers) ? data.answers : [];
}

/* ── 4. Validate, then fill ───────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The form option an answer refers to, or null — a choice is never invented or approximated loosely. */
function matchOption(answer: string, options: string[]): number | null {
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

type Planned = { question: FormQuestion; value: string | boolean | number[]; display: string } | { question: FormQuestion; skip: string };

function plan(question: FormQuestion, model: ModelAnswer | undefined, fromPerson = false): Planned {
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

const AUTOCOMPLETE_LABEL = /location|city|town|where.*(based|located|live)|based in|residen/i;

/** The marked element, or — if the page re-rendered and dropped our marker while the model was thinking — its stable id/name. */
async function locate(ctx: Interactable, question: FormQuestion, option?: number) {
  const marked = ctx.locator(option === undefined ? `[data-cus-q="${question.id}"]` : `[data-cus-q="${question.id}"][data-cus-opt="${option}"]`);
  if ((await marked.count()) > 0) return marked.first();
  const stable = question.selectors?.[option ?? 0];
  return stable ? ctx.locator(stable).first() : marked.first();
}

async function apply(ctx: Interactable, p: Extract<Planned, { value: unknown }>): Promise<{ ok: boolean; reason?: string }> {
  const { question, value } = p;
  const first = await locate(ctx, question);
  const field = { first: () => first };
  if (question.kind === "combobox") {
    const wanted = question.options?.length && Array.isArray(value) ? question.options[(value as number[])[0]] : String(value);
    const r = await chooseComboboxOption(first, wanted);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  return { ok: await applySimple(ctx, p, field) };
}

async function applySimple(ctx: Interactable, p: Extract<Planned, { value: unknown }>, field: { first: () => ReturnType<Interactable["locator"]> }): Promise<boolean> {
  const { question, value } = p;
  try {
    if (question.kind === "text" && AUTOCOMPLETE_LABEL.test(`${question.label} ${question.placeholder ?? ""}`)) {
      // A location/city box usually wants a suggestion picked, and some (Lever's) throw away typed text that wasn't
      // picked from the list. fill() sets the value without the keystrokes that make suggestions appear, so type it.
      const el = field.first();
      await el.click({ timeout: 5_000 });
      await el.fill("", { timeout: 3_000 });
      await el.pressSequentially(String(value), { delay: 40 });
      await pickAutocompleteSuggestion(el, String(value));
      await el.blur().catch(() => undefined);
      await el.page().waitForTimeout(250);
      return (await el.inputValue()).trim() !== "";
    }
    if (question.kind === "text" || question.kind === "textarea") {
      await field.first().fill(String(value), { timeout: 5_000 });
      return (await field.first().inputValue()).trim() !== "";
    }
    if (question.kind === "select") {
      const wanted = question.options![(value as number[])[0]];
      await field.first().selectOption({ label: wanted }, { timeout: 5_000 });
      return (await field.first().evaluate((el) => (el as HTMLSelectElement).selectedIndex)) > 0;
    }
    if (question.kind === "radio" || question.kind === "checkboxgroup" || question.kind === "checkbox") {
      const indexes = question.kind === "checkbox" ? [undefined] : (value as number[]);
      for (const i of indexes) {
        const option = i === undefined ? field.first() : await locate(ctx, question, i);
        // Custom-styled controls hide the real input behind a label — fall back to clicking the label.
        await option.check({ timeout: 3_000 }).catch(async () => {
          await option.check({ force: true, timeout: 3_000 }).catch(async () => {
            await option.evaluate((el) => ((el as HTMLInputElement).labels?.[0] ?? el.parentElement)?.click());
          });
        });
        if (!(await option.isChecked().catch(() => false))) return false;
      }
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Finds the unanswered questions on the current form and answers what the candidate's profile
 * supports. Never throws. `requiredMissing` non-empty means: do not submit this step.
 */
export async function answerFormQuestions(ctx: Interactable, candidate: ICandidate, job: JobInfo, coverLetter?: string): Promise<QuestionResult> {
  const result: QuestionResult = { asked: 0, filled: [], skipped: [], requiredMissing: [], fromSaved: 0, savedForPerson: 0 };

  const questions = (await extractQuestions(ctx)).filter((q) => q.label || q.kind === "checkbox");
  result.asked = questions.length;
  if (questions.length === 0) return result;

  // Custom dropdowns have to be opened to see what they offer; a short list becomes a normal choice question,
  // a long or search-as-you-type one is answered with text that is typed in and then matched.
  for (const q of questions) {
    if (q.kind !== "combobox" || NEVER_FILL.test(q.label)) continue;
    const options = await readComboboxOptions(await locate(ctx, q));
    if (options) q.options = options;
  }

  // 1) Answers a person saved for this candidate win over anything a model would write.
  const saved = await lookupSavedAnswers(candidate._id as never, questions.filter((q) => !NEVER_FILL.test(q.label)).map((q) => ({ id: q.id, label: q.label }))).catch(() => ({ answers: new Map<string, { answer: string; savedId: string }>() }));

  // 2) Only the rest — and only questions a model may legitimately answer — go to the model.
  const askable = questions.filter(
    (q) =>
      !saved.answers.has(q.id) &&
      !NEVER_FILL.test(q.label) &&
      !SELF_ID.test(q.label) &&
      !(q.kind === "checkbox" && (CONSENT.test(q.label) || ATTESTATION.test(q.label) || /\[(yes|no)\]$/i.test(q.label)))
  );
  let answers: ModelAnswer[] = [];
  if (askable.length > 0) {
    try {
      answers = await askModel(askable, candidate, job, coverLetter);
    } catch (err) {
      result.error = `AI question-answering unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const byId = new Map<string, ModelAnswer>(answers.map((a) => [a.id, a]));
  for (const [id, hit] of saved.answers) byId.set(id, { id, answer: hit.answer });

  const usedSaved: string[] = [];
  const needed: Array<{ label: string; options?: string[] }> = [];
  // Reasons that mean "a person could answer this once and it would work"; not policy refusals.
  const ANSWERABLE_BY_PERSON = /the profile doesn't say|not one of the form's options|no matching options|not answerable from the profile/;

  for (const question of questions) {
    const person = saved.answers.get(question.id);
    const planned = plan(question, byId.get(question.id), !!person);
    if ("skip" in planned) {
      result.skipped.push({ label: question.label, required: question.required, reason: planned.skip });
      if (question.required) {
        result.requiredMissing.push(question.label || "(unlabelled required field)");
        if (ANSWERABLE_BY_PERSON.test(planned.skip) && question.label) needed.push({ label: question.label, options: question.options });
      }
      continue;
    }
    const applied = await apply(ctx, planned);
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

  await markAnswersUsed(usedSaved).catch(() => undefined);
  // Save what blocked this application so a person answers each question once, not once per site.
  if (needed.length > 0) result.savedForPerson = await recordNeededQuestions(candidate._id as never, needed, ctx.url() ? new URL(ctx.url()).hostname : undefined).catch(() => 0);
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
