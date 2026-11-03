import type { ICandidate } from "@/lib/models/Candidate";
import { runJsonPrompt } from "@/lib/adapters/multiProviderAdapter";
import type { FormQuestion, JobInfo, ModelAnswer } from "@/lib/automation/formEngine";

/**
 * The AI half of form answering (server only): turns a candidate's recorded profile into answers for the
 * questions on an application form. The accuracy rules are in the prompt and in formQuestions.ts, which validates
 * every answer before anything is typed into a page.
 */

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

export async function askModel(questions: FormQuestion[], candidate: ICandidate, job: JobInfo, coverLetter?: string): Promise<ModelAnswer[]> {
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
